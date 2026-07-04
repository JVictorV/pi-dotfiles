import * as path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Result } from "effect";

import type { HerdrFileSystemFailed } from "./errors";
import { isDirectory, readDirectory, readTextFile } from "./runtime-files";
import type { AgentDefinition, AgentDiscovery, AgentScope } from "./types";

type AgentFrontmatter = Record<string, unknown>;

const frontmatterString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const frontmatterBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") {
		return true;
	}
	if (normalized === "false") {
		return false;
	}
	return undefined;
};

export const buildTaskPrompt = (
	name: string,
	task: string,
	agentType: string | undefined,
): string => {
	const agentLine = agentType ? `- Agent type: ${agentType}` : "- Agent type: plain panel subagent";
	return `You are a pi subagent named ${JSON.stringify(name)}, spawned by a herdr orchestrator.\n\nOperational contract:\n- Work in the current repository/cwd unless the task explicitly says otherwise.\n${agentLine}\n- Do not close this terminal/panel.\n- Keep changes minimal. Only edit files if the task explicitly allows edits.\n- If you become blocked, clearly write \`STATUS: blocked\` and explain the blocker.\n- When complete, clearly write \`STATUS: done\` followed by a concise handoff.\n- Include files inspected/changed, commands run, results, risks, and open questions.\n\nTask:\n${task.trim()}\n`;
};

const findNearestProjectAgentsDir: (
	cwd: string,
) => Effect.Effect<string | null, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (cwd) {
		let current = cwd;
		while (true) {
			const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
			if (yield* isDirectory(candidate)) {
				return candidate;
			}
			const parent = path.dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	},
);

const loadAgentsFromDir: (
	directory: string,
	source: "user" | "project",
) => Effect.Effect<ReadonlyArray<AgentDefinition>, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (directory, source) {
		const fs = yield* FileSystem.FileSystem;
		const names = yield* readDirectory(directory);
		const agents: AgentDefinition[] = [];
		for (const fileName of names) {
			if (!fileName.endsWith(".md")) {
				continue;
			}
			const filePath = path.join(directory, fileName);
			const stat = yield* fs.stat(filePath).pipe(Effect.result);
			if (Result.isFailure(stat) || stat.success.type !== "File") {
				continue;
			}
			const content = yield* readTextFile(filePath).pipe(Effect.result);
			if (Result.isFailure(content) || content.success === undefined) {
				continue;
			}
			const parsed = parseFrontmatter<AgentFrontmatter>(content.success);
			const name = frontmatterString(parsed.frontmatter.name);
			const description = frontmatterString(parsed.frontmatter.description);
			if (!name || !description) {
				continue;
			}
			const tools = frontmatterString(parsed.frontmatter.tools)
				?.split(",")
				.map((tool) => tool.trim())
				.filter((tool) => tool.length > 0);
			agents.push({
				name,
				description,
				tools: tools && tools.length > 0 ? tools : undefined,
				allowSpawn: frontmatterBoolean(parsed.frontmatter.allowSpawn),
				model: frontmatterString(parsed.frontmatter.model),
				thinking: frontmatterString(parsed.frontmatter.thinking),
				systemPrompt: parsed.body.trim(),
				source,
				filePath,
			});
		}
		return agents;
	});

export const discoverAgents: (
	cwd: string,
	scope: AgentScope,
) => Effect.Effect<AgentDiscovery, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (cwd, scope) {
		const userDir = path.join(getAgentDir(), "agents");
		const projectAgentsDir = yield* findNearestProjectAgentsDir(cwd);
		const userAgents = scope === "project" ? [] : yield* loadAgentsFromDir(userDir, "user");
		const projectAgents =
			scope === "user" || !projectAgentsDir
				? []
				: yield* loadAgentsFromDir(projectAgentsDir, "project");
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
	});

export const formatAgentTypes = (discovery: AgentDiscovery): string => {
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
