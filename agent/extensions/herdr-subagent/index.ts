import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import { StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	parseFrontmatter,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type HerdrSubagentAction =
	| "status"
	| "agent-types"
	| "spawn"
	| "inspect"
	| "send"
	| "wait"
	| "focus"
	| "close";
type PaneReadSource = "visible" | "recent" | "recent-unwrapped";
type WaitStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type AgentScope = "user" | "project" | "both";

const ACTIONS: ReadonlyArray<HerdrSubagentAction> = [
	"status",
	"agent-types",
	"spawn",
	"inspect",
	"send",
	"wait",
	"focus",
	"close",
];
const SOURCES: ReadonlyArray<PaneReadSource> = ["visible", "recent", "recent-unwrapped"];
const WAIT_STATUSES: ReadonlyArray<WaitStatus> = ["idle", "working", "blocked", "done", "unknown"];
const AGENT_SCOPES: ReadonlyArray<AgentScope> = ["user", "project", "both"];

const DEFAULT_INSPECT_LINES = 120;
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const WAIT_POLL_INTERVAL_MS = 2_000;
const WAIT_IDLE_CONFIRMATIONS = 2;
const HERDR_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const RUNTIME_DIR = path.join(getAgentDir(), "herdr-subagents");
const REGISTRY_PATH = path.join(RUNTIME_DIR, "registry.json");

interface HerdrSubagentParams {
	readonly action: HerdrSubagentAction;
	readonly name?: string;
	readonly target?: string;
	readonly task?: string;
	readonly agentType?: string;
	readonly agentScope?: AgentScope;
	readonly confirmProjectAgents?: boolean;
	readonly cwd?: string;
	readonly workspace?: string;
	readonly label?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly message?: string;
	readonly lines?: number;
	readonly source?: PaneReadSource;
	readonly status?: WaitStatus;
	readonly timeoutMs?: number;
}

interface CommandSuccess {
	readonly ok: true;
	readonly stdout: string;
	readonly stderr: string;
}

interface CommandFailure {
	readonly ok: false;
	readonly message: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly timedOut: boolean;
}

type CommandOutcome = CommandSuccess | CommandFailure;

interface RegistryEntry {
	readonly name: string;
	readonly target: string;
	readonly paneId: string;
	readonly tabId?: string;
	readonly workspaceId?: string;
	readonly terminalId?: string;
	readonly cwd: string;
	readonly label: string;
	readonly agentType?: string;
	readonly model?: string;
	readonly taskFile: string;
	readonly systemPromptFile?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface Registry {
	readonly version: 1;
	readonly entries: Record<string, RegistryEntry>;
}

interface AgentDefinition {
	readonly name: string;
	readonly description: string;
	readonly tools?: ReadonlyArray<string>;
	readonly model?: string;
	readonly thinking?: string;
	readonly systemPrompt: string;
	readonly source: "user" | "project";
	readonly filePath: string;
}

interface AgentDiscovery {
	readonly agents: ReadonlyArray<AgentDefinition>;
	readonly projectAgentsDir: string | null;
}

interface ResolvedPane {
	readonly name: string;
	readonly paneId: string;
	readonly liveAgent?: Record<string, unknown>;
}

/** Expected failure of a herdr_subagent action, rejected at the tool boundary. */
class HerdrSubagentToolError extends Schema.TaggedErrorClass<HerdrSubagentToolError>()(
	"HerdrSubagentToolError",
	{ message: Schema.String },
) {}

interface ActionFailure {
	readonly failed: true;
	readonly message: string;
}

const actionFailure = (message: string): ActionFailure => ({ failed: true, message });

const isActionFailure = (value: unknown): value is ActionFailure =>
	isRecord(value) && value.failed === true && typeof value.message === "string";

/**
 * Reject the tool call with an expected failure. Pi only marks a tool result as
 * errored when execute rejects, so failures-as-values are translated here.
 */
const rejectAction = (message: string): Promise<never> =>
	Effect.runPromise(Effect.fail(HerdrSubagentToolError.make({ message })));

const textContent = (text: string): TextContent => ({ type: "text", text });

const nowIso = (): string => new Date().toISOString();

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const getRecord = (
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined => {
	const value = record[key];
	return isRecord(value) ? value : undefined;
};

const getArray = (record: Record<string, unknown>, key: string): ReadonlyArray<unknown> => {
	const value = record[key];
	return Array.isArray(value) ? value : [];
};

const getString = (record: Record<string, unknown>, key: string): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};

const getBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
};

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const parseJsonObject = (text: string): Promise<Record<string, unknown> | undefined> =>
	Effect.runPromise(
		decodeUnknownJson(text).pipe(
			Effect.map((value) => (isRecord(value) ? value : undefined)),
			Effect.catch(() => Effect.succeed(undefined)),
		),
	);

const isCommandFailure = (value: unknown): value is CommandFailure =>
	isRecord(value) && value.ok === false && typeof value.message === "string";

const isRunningInsideHerdr = (): boolean => {
	// oxlint-disable-next-line effect/no-process-env -- HERDR_ENV is herdr's process-boundary capability flag; Effect Config memoizes misses and is wrong for reload/tests that mutate env.
	return process.env.HERDR_ENV === "1";
};

const truncateForModel = (
	text: string,
	lines = DEFAULT_MAX_LINES,
): { readonly text: string; readonly truncated: boolean } => {
	const truncation = truncateTail(text, {
		maxLines: Math.min(lines, DEFAULT_MAX_LINES),
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}
	return {
		text: `${truncation.content}\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`,
		truncated: true,
	};
};

const commandFailureText = (failure: CommandFailure): string => {
	const output = [failure.stdout, failure.stderr]
		.filter((part) => part.trim().length > 0)
		.join("\n");
	const suffix = output.trim().length > 0 ? `\n${truncateForModel(output).text}` : "";
	return `${failure.message}${suffix}`;
};

const runHerdr = (
	args: ReadonlyArray<string>,
	signal: AbortSignal | undefined,
	timeoutMs = HERDR_TIMEOUT_MS,
): Promise<CommandOutcome> =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const child = spawn("herdr", [...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (killTimer) {
				clearTimeout(killTimer);
			}
			signal?.removeEventListener("abort", abort);
		};

		const finish = (outcome: CommandOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(outcome);
		};

		const stopChild = (): void => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			// Escalate: a herdr call that traps or ignores SIGTERM would otherwise
			// keep this promise pending forever and hang the tool call.
			killTimer ??= setTimeout(() => {
				child.kill("SIGKILL");
			}, KILL_GRACE_MS);
			killTimer.unref?.();
		};

		function abort(): void {
			stopChild();
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", () => {
			finish({
				ok: false,
				message: "Failed to start herdr. Is the herdr CLI installed and on PATH?",
				stdout,
				stderr,
				code: null,
				timedOut,
			});
		});

		child.on("close", (code) => {
			if (code === 0) {
				finish({ ok: true, stdout, stderr });
				return;
			}
			finish({
				ok: false,
				message: timedOut
					? `herdr timed out after ${timeoutMs}ms`
					: `herdr exited with code ${code ?? "unknown"}`,
				stdout,
				stderr,
				code,
				timedOut,
			});
		});

		if (signal?.aborted) {
			abort();
		} else {
			signal?.addEventListener("abort", abort, { once: true });
		}

		timeout = setTimeout(() => {
			timedOut = true;
			stopChild();
		}, timeoutMs);
		timeout.unref?.();
	});

const runHerdrJson = async (
	args: ReadonlyArray<string>,
	signal: AbortSignal | undefined,
	timeoutMs = HERDR_TIMEOUT_MS,
): Promise<Record<string, unknown> | CommandFailure> => {
	const outcome = await runHerdr(args, signal, timeoutMs);
	if (!outcome.ok) {
		return outcome;
	}
	const parsed = await parseJsonObject(outcome.stdout);
	if (!parsed) {
		return {
			ok: false,
			message: "herdr returned non-JSON output",
			stdout: outcome.stdout,
			stderr: outcome.stderr,
			code: 0,
			timedOut: false,
		};
	}
	return parsed;
};

const emptyRegistry = (): Registry => ({ version: 1, entries: {} });

const readTextFile = (filePath: string): Promise<string | undefined> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: () => fs.readFile(filePath, "utf8"),
			catch: (cause) => cause,
		}).pipe(Effect.catch(() => Effect.succeed(undefined))),
	);

const readDirectory = (directory: string): Promise<ReadonlyArray<Dirent>> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: () => fs.readdir(directory, { withFileTypes: true }),
			catch: (cause) => cause,
		}).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<Dirent>>([]))),
	);

const isDirectory = (directory: string): Promise<boolean> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: () => fs.stat(directory),
			catch: (cause) => cause,
		}).pipe(
			Effect.map((stat) => stat.isDirectory()),
			Effect.catch(() => Effect.succeed(false)),
		),
	);

const decodeRegistryEntry = (name: string, input: unknown): RegistryEntry | undefined => {
	if (!isRecord(input)) {
		return undefined;
	}
	const target = getString(input, "target");
	const paneId = getString(input, "paneId");
	const cwd = getString(input, "cwd");
	const label = getString(input, "label");
	const taskFile = getString(input, "taskFile");
	const createdAt = getString(input, "createdAt");
	const updatedAt = getString(input, "updatedAt");
	if (!target || !paneId || !cwd || !label || !taskFile || !createdAt || !updatedAt) {
		return undefined;
	}
	return {
		name,
		target,
		paneId,
		tabId: getString(input, "tabId"),
		workspaceId: getString(input, "workspaceId"),
		terminalId: getString(input, "terminalId"),
		cwd,
		label,
		agentType: getString(input, "agentType"),
		model: getString(input, "model"),
		taskFile,
		systemPromptFile: getString(input, "systemPromptFile"),
		createdAt,
		updatedAt,
	};
};

const readRegistry = async (): Promise<Registry> => {
	const text = await readTextFile(REGISTRY_PATH);
	if (text === undefined) {
		return emptyRegistry();
	}
	const parsed = await parseJsonObject(text);
	const entriesRecord = parsed ? getRecord(parsed, "entries") : undefined;
	if (!entriesRecord) {
		return emptyRegistry();
	}
	const entries: Record<string, RegistryEntry> = {};
	for (const [name, value] of Object.entries(entriesRecord)) {
		const entry = decodeRegistryEntry(name, value);
		if (entry) {
			entries[name] = entry;
		}
	}
	return { version: 1, entries };
};

const writeRegistry = async (registry: Registry): Promise<void> => {
	await fs.mkdir(RUNTIME_DIR, { recursive: true });
	// Write-then-rename so a concurrent readRegistry never sees a torn file
	// (a torn read parses as an empty registry and would drop entries on the
	// next write).
	const tempPath = `${REGISTRY_PATH}.tmp-${randomUUID()}`;
	await fs.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await fs.rename(tempPath, REGISTRY_PATH);
};

let registryLock: Promise<unknown> = Promise.resolve();

const withRegistryLock = <T>(operation: () => Promise<T>): Promise<T> => {
	const next = registryLock.then(operation, operation);
	registryLock = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
};

/**
 * Serialized read-modify-write for the registry. Sibling tool calls run in
 * parallel in pi, so every mutation must re-read the current registry inside
 * the lock; snapshotting entries earlier and writing them back would drop
 * concurrent spawns (last writer wins).
 */
const mutateRegistry = (
	mutate: (entries: Record<string, RegistryEntry>) => Record<string, RegistryEntry>,
): Promise<Registry> =>
	withRegistryLock(async () => {
		const current = await readRegistry();
		const nextRegistry: Registry = { version: 1, entries: mutate({ ...current.entries }) };
		await writeRegistry(nextRegistry);
		return nextRegistry;
	});

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const safeFilePart = (value: string): string => {
	const cleaned = value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "subagent";
};

const writeRuntimeFile = async (prefix: string, name: string, content: string): Promise<string> => {
	await fs.mkdir(RUNTIME_DIR, { recursive: true });
	const filePath = path.join(RUNTIME_DIR, `${prefix}-${safeFilePart(name)}-${randomUUID()}.md`);
	await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return filePath;
};

const buildTaskPrompt = (name: string, task: string, agentType: string | undefined): string => {
	const agentLine = agentType ? `- Agent type: ${agentType}` : "- Agent type: plain panel subagent";
	return `You are a pi subagent named ${JSON.stringify(name)}, spawned by a herdr orchestrator.\n\nOperational contract:\n- Work in the current repository/cwd unless the task explicitly says otherwise.\n${agentLine}\n- Do not close this terminal/panel.\n- Keep changes minimal. Only edit files if the task explicitly allows edits.\n- If you become blocked, clearly write \`STATUS: blocked\` and explain the blocker.\n- When complete, clearly write \`STATUS: done\` followed by a concise handoff.\n- Include files inspected/changed, commands run, results, risks, and open questions.\n\nTask:\n${task.trim()}\n`;
};

const findNearestProjectAgentsDir = async (cwd: string): Promise<string | null> => {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (await isDirectory(candidate)) {
			return candidate;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
};

const loadAgentsFromDir = async (
	directory: string,
	source: "user" | "project",
): Promise<ReadonlyArray<AgentDefinition>> => {
	const dirents = await readDirectory(directory);
	const agents: AgentDefinition[] = [];
	for (const dirent of dirents) {
		if (!dirent.name.endsWith(".md") || (!dirent.isFile() && !dirent.isSymbolicLink())) {
			continue;
		}
		const filePath = path.join(directory, dirent.name);
		const content = await readTextFile(filePath);
		if (content === undefined) {
			continue;
		}
		const parsed = parseFrontmatter<Record<string, string>>(content);
		const name = parsed.frontmatter.name;
		const description = parsed.frontmatter.description;
		if (!name || !description) {
			continue;
		}
		const tools = parsed.frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter((tool) => tool.length > 0);
		agents.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: parsed.frontmatter.model,
			thinking: parsed.frontmatter.thinking,
			systemPrompt: parsed.body.trim(),
			source,
			filePath,
		});
	}
	return agents;
};

const discoverAgents = async (cwd: string, scope: AgentScope): Promise<AgentDiscovery> => {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = await findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : await loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: await loadAgentsFromDir(projectAgentsDir, "project");
	const byName = new Map<string, AgentDefinition>();
	if (scope === "both") {
		for (const agent of userAgents) {
			byName.set(agent.name, agent);
		}
		for (const agent of projectAgents) {
			byName.set(agent.name, agent);
		}
	} else {
		for (const agent of scope === "user" ? userAgents : projectAgents) {
			byName.set(agent.name, agent);
		}
	}
	return { agents: [...byName.values()], projectAgentsDir };
};

const formatAgentTypes = (discovery: AgentDiscovery): string => {
	if (discovery.agents.length === 0) {
		return "No agent types found.";
	}
	return discovery.agents
		.map((agent) => {
			const tools = agent.tools && agent.tools.length > 0 ? ` tools=${agent.tools.join(",")}` : "";
			const model = agent.model ? ` model=${agent.model}` : "";
			const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
			return `- ${agent.name} (${agent.source})${model}${thinking}${tools}: ${agent.description}`;
		})
		.join("\n");
};

const commandJsonResult = (
	response: Record<string, unknown>,
	pathKeys: ReadonlyArray<string>,
): Record<string, unknown> | undefined => {
	let current: Record<string, unknown> | undefined = response;
	for (const key of pathKeys) {
		if (!current) {
			return undefined;
		}
		current = getRecord(current, key);
	}
	return current;
};

const currentPane = async (
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | CommandFailure> => {
	const response = await runHerdrJson(["pane", "current", "--current"], signal);
	if (isCommandFailure(response)) {
		return response;
	}
	const pane = commandJsonResult(response, ["result", "pane"]);
	return (
		pane ?? {
			ok: false,
			message: "Could not find current pane in herdr response",
			stdout: JSON.stringify(response),
			stderr: "",
			code: 0,
			timedOut: false,
		}
	);
};

const liveAgent = async (
	target: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | undefined> => {
	const response = await runHerdrJson(["agent", "get", target], signal);
	if (isCommandFailure(response)) {
		return undefined;
	}
	return commandJsonResult(response, ["result", "agent"]);
};

const resolvePane = async (
	target: string,
	registry: Registry,
	signal: AbortSignal | undefined,
): Promise<ResolvedPane | CommandFailure> => {
	const entry = registry.entries[target];
	const candidates = [entry?.target, entry?.terminalId, entry?.paneId, target].filter(
		(candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
	);

	for (const candidate of candidates) {
		const agent = await liveAgent(candidate, signal);
		const paneId = agent ? getString(agent, "pane_id") : undefined;
		if (agent && paneId) {
			if (entry) {
				const updated: RegistryEntry = {
					...entry,
					target: getString(agent, "terminal_id") ?? paneId,
					paneId,
					terminalId: getString(agent, "terminal_id") ?? entry.terminalId,
					tabId: getString(agent, "tab_id") ?? entry.tabId,
					workspaceId: getString(agent, "workspace_id") ?? entry.workspaceId,
					updatedAt: nowIso(),
				};
				await mutateRegistry((entries) =>
					entries[entry.name] ? { ...entries, [entry.name]: updated } : entries,
				);
			}
			return { name: entry?.name ?? target, paneId, liveAgent: agent };
		}
	}

	if (entry) {
		return { name: entry.name, paneId: entry.paneId };
	}
	if (target.includes(":p") || /^\w+-p\d+$/.test(target)) {
		return { name: target, paneId: target };
	}
	const known = Object.keys(registry.entries);
	return {
		ok: false,
		message: `Could not resolve subagent or pane target: ${target}. ${
			known.length > 0 ? `Known subagents: ${known.join(", ")}.` : "No subagents are registered."
		} Run the status action to list live agents and pane ids.`,
		stdout: "",
		stderr: "",
		code: null,
		timedOut: false,
	};
};

const commandStatus = async (signal: AbortSignal | undefined) => {
	const registry = await readRegistry();
	const response = await runHerdrJson(["agent", "list"], signal);
	if (isCommandFailure(response)) {
		return actionFailure(commandFailureText(response));
	}
	const result = getRecord(response, "result");
	const liveAgents = result ? getArray(result, "agents").filter(isRecord) : [];
	const nextEntries: Record<string, RegistryEntry> = { ...registry.entries };
	const liveUpdates: Record<string, RegistryEntry> = {};
	const seenNames = new Set<string>();
	const rows: string[] = [];

	for (const agent of liveAgents) {
		const terminalId = getString(agent, "terminal_id");
		const paneId = getString(agent, "pane_id");
		const tabId = getString(agent, "tab_id");
		const matched = Object.values(nextEntries).find(
			(entry) =>
				entry.target === terminalId ||
				entry.terminalId === terminalId ||
				entry.paneId === paneId ||
				entry.tabId === tabId,
		);
		if (matched && paneId) {
			seenNames.add(matched.name);
			const updated: RegistryEntry = {
				...matched,
				target: terminalId ?? paneId,
				terminalId: terminalId ?? matched.terminalId,
				paneId,
				tabId: tabId ?? matched.tabId,
				workspaceId: getString(agent, "workspace_id") ?? matched.workspaceId,
				updatedAt: nowIso(),
			};
			nextEntries[matched.name] = updated;
			liveUpdates[matched.name] = updated;
		}
		const name = matched?.name ?? "-";
		const status = getString(agent, "agent_status") ?? "unknown";
		const focus = getBoolean(agent, "focused") ? "*" : " ";
		const cwd = getString(agent, "foreground_cwd") ?? getString(agent, "cwd") ?? "";
		rows.push(
			`${focus} ${name.padEnd(22)} ${status.padEnd(8)} ${(paneId ?? "").padEnd(12)} ${cwd}`,
		);
	}

	for (const entry of Object.values(nextEntries)) {
		if (!seenNames.has(entry.name)) {
			rows.push(`  ${entry.name.padEnd(22)} missing  ${entry.paneId.padEnd(12)} ${entry.cwd}`);
		}
	}

	await mutateRegistry((entries) => {
		for (const [name, updated] of Object.entries(liveUpdates)) {
			if (entries[name]) {
				entries[name] = updated;
			}
		}
		return entries;
	});
	const text =
		rows.length > 0
			? `F NAME                   STATUS   PANE         CWD\n${rows.join("\n")}`
			: "No herdr agents found.";
	return {
		content: [textContent(text)],
		details: { action: "status", registry: { version: 1, entries: nextEntries } },
	};
};

const commandAgentTypes = async (params: HerdrSubagentParams, ctxCwd: string) => {
	const discovery = await discoverAgents(ctxCwd, params.agentScope ?? "user");
	return {
		content: [textContent(formatAgentTypes(discovery))],
		details: {
			action: "agent-types",
			projectAgentsDir: discovery.projectAgentsDir,
			agents: discovery.agents,
		},
	};
};

const commandSpawn = async (
	params: HerdrSubagentParams,
	signal: AbortSignal | undefined,
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: { confirm(title: string, message: string): Promise<boolean> };
	},
) => {
	if (!params.name || !params.task) {
		return actionFailure("spawn requires both name and task.");
	}

	const registry = await readRegistry();
	if (registry.entries[params.name]) {
		return actionFailure(
			`A subagent named ${params.name} is already registered. Use close first, or pick a different name.`,
		);
	}

	const discovery = await discoverAgents(ctx.cwd, params.agentScope ?? "user");
	const agent = params.agentType
		? discovery.agents.find((candidate) => candidate.name === params.agentType)
		: undefined;
	if (params.agentType && !agent) {
		return actionFailure(
			`Unknown agentType ${params.agentType}.\n\n${formatAgentTypes(discovery)}`,
		);
	}

	if (agent?.source === "project" && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Run project-local herdr subagent?",
			`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
		);
		if (!ok) {
			return {
				content: [textContent("Canceled: project-local agent was not approved.")],
				details: { action: "spawn", projectAgentsDir: discovery.projectAgentsDir },
			};
		}
	}

	const pane = await currentPane(signal);
	if (isCommandFailure(pane) && !params.workspace) {
		return actionFailure(commandFailureText(pane));
	}
	const workspaceId =
		params.workspace ?? (isCommandFailure(pane) ? undefined : getString(pane, "workspace_id"));
	if (!workspaceId) {
		return actionFailure("Could not determine herdr workspace. Pass workspace explicitly.");
	}
	const cwd =
		params.cwd ??
		(isCommandFailure(pane)
			? ctx.cwd
			: (getString(pane, "foreground_cwd") ?? getString(pane, "cwd") ?? ctx.cwd));
	const label = params.label ?? `agent: ${params.name}`;
	const createArgs = [
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--cwd",
		cwd,
		"--label",
		label,
		"--env",
		`HERDR_SUBAGENT_NAME=${params.name}`,
		"--no-focus",
	];
	const created = await runHerdrJson(createArgs, signal);
	if (isCommandFailure(created)) {
		return actionFailure(commandFailureText(created));
	}
	const rootPane =
		commandJsonResult(created, ["result", "root_pane"]) ??
		commandJsonResult(created, ["result", "pane"]);
	const tab = commandJsonResult(created, ["result", "tab"]);
	const paneId = rootPane ? getString(rootPane, "pane_id") : undefined;
	if (!paneId) {
		return actionFailure(
			`Could not find root pane in herdr response:\n${JSON.stringify(created, null, 2)}`,
		);
	}
	const terminalId = rootPane ? getString(rootPane, "terminal_id") : undefined;
	const tabId =
		(tab ? getString(tab, "tab_id") : undefined) ??
		(rootPane ? getString(rootPane, "tab_id") : undefined);
	await runHerdr(["pane", "rename", paneId, label], signal);

	const taskFile = await writeRuntimeFile(
		"task",
		params.name,
		buildTaskPrompt(params.name, params.task, params.agentType),
	);
	const systemPromptFile = agent?.systemPrompt
		? await writeRuntimeFile("system", params.name, agent.systemPrompt)
		: undefined;
	const model = params.model ?? agent?.model;
	const thinking = params.thinking ?? agent?.thinking;
	const tools = params.tools ?? agent?.tools;
	const commandParts = ["pi", "--name", `subagent: ${params.name}`];
	if (model) {
		commandParts.push("--model", model);
	}
	if (thinking) {
		commandParts.push("--thinking", thinking);
	}
	if (tools && tools.length > 0) {
		commandParts.push("--tools", tools.join(","));
	}
	if (systemPromptFile) {
		commandParts.push("--append-system-prompt", systemPromptFile);
	}
	commandParts.push(`@${taskFile}`);
	const command = commandParts.map(shellQuote).join(" ");
	const run = await runHerdr(["pane", "run", paneId, command], signal);
	if (!run.ok) {
		return actionFailure(commandFailureText(run));
	}

	const entry: RegistryEntry = {
		name: params.name,
		target: terminalId ?? paneId,
		paneId,
		tabId,
		workspaceId,
		terminalId,
		cwd,
		label,
		agentType: params.agentType,
		model,
		taskFile,
		systemPromptFile,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	const nextRegistry = await mutateRegistry((entries) => ({ ...entries, [entry.name]: entry }));

	return {
		content: [
			textContent(
				`Spawned ${params.name} in herdr panel.\nTarget: ${entry.target}\nPane: ${paneId}\nTab: ${tabId ?? "unknown"}\nWorkspace: ${workspaceId}\nCWD: ${cwd}\n\nNext: inspect ${params.name} or wait for status done.`,
			),
		],
		details: { action: "spawn", entry, registry: nextRegistry },
	};
};

const requireTarget = (params: HerdrSubagentParams): string | undefined =>
	params.target ?? params.name;

const commandInspect = async (params: HerdrSubagentParams, signal: AbortSignal | undefined) => {
	const target = requireTarget(params);
	if (!target) {
		return actionFailure("inspect requires target or name.");
	}
	const registry = await readRegistry();
	const resolved = await resolvePane(target, registry, signal);
	if (isCommandFailure(resolved)) {
		return actionFailure(commandFailureText(resolved));
	}
	const lines = params.lines ?? DEFAULT_INSPECT_LINES;
	const source = params.source ?? "recent-unwrapped";
	const outcome = await runHerdr(
		["pane", "read", resolved.paneId, "--source", source, "--lines", String(lines)],
		signal,
	);
	if (!outcome.ok) {
		return actionFailure(commandFailureText(outcome));
	}
	const truncated = truncateForModel(outcome.stdout, lines);
	return {
		content: [textContent(truncated.text)],
		details: { action: "inspect", target, resolved, source, lines, truncated: truncated.truncated },
	};
};

const commandSend = async (params: HerdrSubagentParams, signal: AbortSignal | undefined) => {
	const target = requireTarget(params);
	if (!target || !params.message) {
		return actionFailure("send requires target/name and message.");
	}
	const registry = await readRegistry();
	const resolved = await resolvePane(target, registry, signal);
	if (isCommandFailure(resolved)) {
		return actionFailure(commandFailureText(resolved));
	}
	const outcome = await runHerdr(["pane", "run", resolved.paneId, params.message], signal);
	if (!outcome.ok) {
		return actionFailure(commandFailureText(outcome));
	}
	return {
		content: [textContent(`Sent message to ${resolved.name} (${resolved.paneId}).`)],
		details: { action: "send", resolved },
	};
};

/**
 * Wait until a subagent has finished its turn.
 *
 * Herdr's `done` agent status means "finished and not yet viewed": pi only ever
 * reports `working`/`blocked`/`idle`, and herdr synthesizes `done` for an idle
 * pane nobody has looked at. A finished pane that is visible or already viewed
 * reports `idle` directly, so `herdr wait agent-status --status done` can block
 * for the full timeout even though the subagent finished long ago. Poll the
 * agent status instead and accept either `done` or a stable `idle`.
 *
 * `idle` must be observed on {@link WAIT_IDLE_CONFIRMATIONS} consecutive polls
 * because pi publishes a transient `idle` at session start, before the spawned
 * task begins working.
 */
const waitForFinished = async (
	resolved: ResolvedPane,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<{ readonly observed: "done" | "idle" } | ActionFailure> => {
	const deadline = Date.now() + timeoutMs;
	// Scale the poll interval down for short timeouts so a quick wait can still
	// confirm consecutive idle polls before the deadline.
	const pollMs = Math.max(100, Math.min(WAIT_POLL_INTERVAL_MS, Math.floor(timeoutMs / 5)));
	let consecutiveIdle = 0;
	let lastStatus = "unknown";
	for (;;) {
		if (signal?.aborted) {
			return actionFailure("wait was aborted.");
		}
		const agent = await liveAgent(resolved.paneId, signal);
		lastStatus = agent ? (getString(agent, "agent_status") ?? "unknown") : "unknown";
		if (lastStatus === "done") {
			return { observed: "done" };
		}
		if (lastStatus === "idle") {
			consecutiveIdle += 1;
			if (consecutiveIdle >= WAIT_IDLE_CONFIRMATIONS) {
				return { observed: "idle" };
			}
		} else {
			consecutiveIdle = 0;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return actionFailure(
				`wait timed out after ${timeoutMs}ms; last agent status: ${lastStatus}. Inspect ${resolved.name} to check progress, then re-wait.`,
			);
		}
		await sleep(Math.min(pollMs, remaining), signal);
	}
};

const commandWait = async (params: HerdrSubagentParams, signal: AbortSignal | undefined) => {
	const target = requireTarget(params);
	if (!target) {
		return actionFailure("wait requires target or name.");
	}
	const registry = await readRegistry();
	const resolved = await resolvePane(target, registry, signal);
	if (isCommandFailure(resolved)) {
		return actionFailure(commandFailureText(resolved));
	}
	const status = params.status ?? "done";
	const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	if (status === "done") {
		const outcome = await waitForFinished(resolved, timeoutMs, signal);
		if (isActionFailure(outcome)) {
			return outcome;
		}
		const viaIdle =
			outcome.observed === "idle"
				? " (reported idle: the pane was already viewed or finished before the wait)"
				: "";
		return {
			content: [
				textContent(
					`${resolved.name} finished${viaIdle}. Inspect the panel before trusting the result.`,
				),
			],
			details: { action: "wait", resolved, status, observed: outcome.observed },
		};
	}
	const outcome = await runHerdr(
		["wait", "agent-status", resolved.paneId, "--status", status, "--timeout", String(timeoutMs)],
		signal,
		timeoutMs + 1_000,
	);
	if (!outcome.ok) {
		return actionFailure(commandFailureText(outcome));
	}
	return {
		content: [
			textContent(
				`${resolved.name} reached ${status}. Inspect the panel before trusting the result.`,
			),
		],
		details: { action: "wait", resolved, status },
	};
};

const commandFocus = async (params: HerdrSubagentParams, signal: AbortSignal | undefined) => {
	const target = requireTarget(params);
	if (!target) {
		return actionFailure("focus requires target or name.");
	}
	const registry = await readRegistry();
	const entry = registry.entries[target];
	const focusTarget = entry?.target ?? target;
	const outcome = await runHerdr(["agent", "focus", focusTarget], signal);
	if (!outcome.ok) {
		return actionFailure(commandFailureText(outcome));
	}
	return {
		content: [textContent(`Focused ${target}.`)],
		details: { action: "focus", target: focusTarget },
	};
};

const tabExists = async (tabId: string, signal: AbortSignal | undefined): Promise<boolean> => {
	const response = await runHerdrJson(["tab", "get", tabId], signal);
	return !isCommandFailure(response);
};

const removeRegistryEntry = async (name: string): Promise<void> => {
	await mutateRegistry((entries) => {
		delete entries[name];
		return entries;
	});
};

const findRegistryEntry = (registry: Registry, target: string): RegistryEntry | undefined => {
	const byName = registry.entries[target];
	if (byName) {
		return byName;
	}
	return Object.values(registry.entries).find(
		(entry) =>
			entry.target === target ||
			entry.terminalId === target ||
			entry.paneId === target ||
			entry.tabId === target,
	);
};

const commandClose = async (params: HerdrSubagentParams, signal: AbortSignal | undefined) => {
	const target = requireTarget(params);
	if (!target) {
		return actionFailure("close requires target or name.");
	}
	const registry = await readRegistry();
	const entry = findRegistryEntry(registry, target);
	if (entry?.tabId) {
		const outcome = await runHerdr(["tab", "close", entry.tabId], signal);
		if (!outcome.ok) {
			// The tab may already be gone (for example, closed manually in herdr's UI).
			// Keeping the entry would block the name forever, so only surface the
			// failure when the tab still exists; otherwise clean up the stale entry.
			if (await tabExists(entry.tabId, signal)) {
				return actionFailure(commandFailureText(outcome));
			}
			await removeRegistryEntry(entry.name);
			return {
				content: [
					textContent(
						`Tab ${entry.tabId} for ${entry.name} was already gone; removed the stale registry entry.`,
					),
				],
				details: { action: "close", entry, stale: true },
			};
		}
		await removeRegistryEntry(entry.name);
		return {
			content: [textContent(`Closed tab ${entry.tabId} for ${entry.name}.`)],
			details: { action: "close", entry },
		};
	}
	const resolved = await resolvePane(target, registry, signal);
	if (isCommandFailure(resolved)) {
		return actionFailure(commandFailureText(resolved));
	}
	const outcome = await runHerdr(["pane", "close", resolved.paneId], signal);
	if (!outcome.ok) {
		return actionFailure(commandFailureText(outcome));
	}
	// A registry entry without a tabId can still reference this pane; clean it up
	// so the closed pane does not leave a permanently "missing" name behind.
	const paneEntry = entry ?? findRegistryEntry(registry, resolved.paneId);
	if (paneEntry) {
		await removeRegistryEntry(paneEntry.name);
	}
	return {
		content: [textContent(`Closed pane ${resolved.paneId}.`)],
		details: { action: "close", resolved },
	};
};

const runAction = async (
	params: HerdrSubagentParams,
	signal: AbortSignal | undefined,
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: { confirm(title: string, message: string): Promise<boolean> };
	},
) => {
	if (params.action === "status") return await commandStatus(signal);
	if (params.action === "agent-types") return await commandAgentTypes(params, ctx.cwd);
	if (params.action === "spawn") return await commandSpawn(params, signal, ctx);
	if (params.action === "inspect") return await commandInspect(params, signal);
	if (params.action === "send") return await commandSend(params, signal);
	if (params.action === "wait") return await commandWait(params, signal);
	if (params.action === "focus") return await commandFocus(params, signal);
	return await commandClose(params, signal);
};

/** Register herdr-backed pi subagent orchestration tools. */
export default function herdrSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description:
			"Spawn and control pi subagents as real herdr tabs/panels. Supports status, agent-types, spawn, inspect, send, wait, focus, and close. Requires HERDR_ENV=1 for panel control.",
		promptSnippet:
			"Spawn, inspect, command, wait on, focus, and close pi subagents in herdr tabs/panels",
		promptGuidelines: [
			"Use herdr_subagent when the user asks to orchestrate subagents, spawn panel-backed agents, inspect agent panels, or coordinate work across herdr.",
			"Call herdr_subagent with action=status before controlling existing panel-backed subagents.",
			"When using herdr_subagent action=spawn, pass an explicit model unless the user specifically asks to inherit the current/default model.",
			"For herdr_subagent implementation workers, scouts, tests, migrations, data analysis, and clear-spec mechanical work, prefer model openai-codex/gpt-5.5 with thinking medium/high.",
			"For herdr_subagent reviewers, planners, ambiguous investigations, architecture/API/UI/copy judgment, and synthesis, prefer model anthropic/claude-opus-4-8 with thinking high/xhigh.",
			"Avoid spawning anthropic/claude-fable-5 with herdr_subagent by default; Fable should usually orchestrate rather than work. Use it only for pure high-taste critique/copy/UI direction or explicit subjective comparisons.",
			"Prefer one herdr_subagent spawn per task, with tab labels like agent: <name>; inspect a subagent panel before trusting its result.",
			"Keep herdr_subagent fan-out to at most 12 concurrent subagents; start small and scale up only when the task genuinely benefits from parallelism.",
			"For parallel code editing, avoid multiple herdr_subagent workers mutating the same worktree unless the user has explicitly isolated their worktrees.",
		],
		parameters: Type.Object({
			action: StringEnum([...ACTIONS], { description: "Operation to perform." }),
			name: Type.Optional(
				Type.String({
					description: "Registry name for spawn, or a name target for other actions.",
				}),
			),
			target: Type.Optional(
				Type.String({
					description: "Subagent name, terminal id, pane id, or unique herdr agent target.",
				}),
			),
			task: Type.Optional(Type.String({ description: "Task prompt for action=spawn." })),
			agentType: Type.Optional(
				Type.String({
					description: "Optional agent definition from ~/.pi/agent/agents or trusted .pi/agents.",
				}),
			),
			agentScope: Type.Optional(
				StringEnum([...AGENT_SCOPES], { description: "Agent definition scope. Default: user." }),
			),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Confirm before using project-local agent definitions. Default true.",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for a spawned subagent tab." }),
			),
			workspace: Type.Optional(
				Type.String({
					description: "Herdr workspace id for a spawned tab. Defaults to current workspace.",
				}),
			),
			label: Type.Optional(
				Type.String({ description: "Herdr tab/pane label for spawn. Defaults to agent: <name>." }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"pi model for spawned subagent. Usually pass explicitly: openai-codex/gpt-5.5 for workers/scouts/mechanics, anthropic/claude-opus-4-8 for review/planning/taste/synthesis. Overrides agentType model.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"pi thinking level for spawned subagent, e.g. low, medium, high, xhigh. Overrides agentType thinking.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tool allowlist for spawned subagent. Overrides agentType tools.",
				}),
			),
			message: Type.Optional(Type.String({ description: "Follow-up prompt for action=send." })),
			lines: Type.Optional(
				Type.Number({ description: "Lines to read for action=inspect. Default 120." }),
			),
			source: Type.Optional(
				StringEnum([...SOURCES], {
					description: "Pane read source for inspect. Default recent-unwrapped.",
				}),
			),
			status: Type.Optional(
				StringEnum([...WAIT_STATUSES], { description: "Status for action=wait. Default done." }),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Timeout in milliseconds for action=wait. Default 600000." }),
			),
		}),
		async execute(_toolCallId, params: HerdrSubagentParams, signal, _onUpdate, ctx) {
			if (!isRunningInsideHerdr()) {
				return await rejectAction(
					"HERDR_ENV is not 1; herdr_subagent can only inspect or control panels from inside herdr.",
				);
			}

			const result = await runAction(params, signal, ctx);
			if (isActionFailure(result)) {
				return await rejectAction(result.message);
			}
			return result;
		},
	});
}
