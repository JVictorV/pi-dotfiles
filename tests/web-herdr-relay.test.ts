import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { asRecord } from "../agent/extensions/web-herdr-relay/normalization";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const handlers = new Map<string, Handler>();
const events: Record<string, unknown>[] = [];
const messages: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];
let directory: string;
let relaySocket: net.Socket | undefined;
let uploadSocket: net.Socket | undefined;
let idle = true;
let operation = 0;
let commands: ReturnType<ExtensionAPI["getCommands"]> = [];
const originalPane = process.env.HERDR_PANE_ID;
const originalBootstrap = process.env.HERDR_RELAY_BOOTSTRAP_SOCKET;

// SAFETY: The relay only reads these context members in the events exercised here.
const ctx = {
	mode: "tui",
	isIdle: () => idle,
	hasPendingMessages: () => false,
	getContextUsage: () => undefined,
	scopedModels: [],
	modelRegistry: { getAvailable: () => [] },
	sessionManager: {
		getSessionFile: () => "/private/session.jsonl",
		getSessionId: () => "relay-test-session",
		buildContextEntries: () => [],
	},
} as unknown as ExtensionContext;

async function emit(event: ExtensionEvent) {
	const handler = handlers.get(event.type);
	if (handler === undefined) throw new Error(`Missing ${event.type} handler`);
	await handler(event, ctx);
}

async function listen(path: string, accept: (socket: net.Socket) => void) {
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		accept(socket);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

function lines(socket: net.Socket, receive: (value: Record<string, unknown>) => void) {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += String(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const record = asRecord(parseJson(buffer.slice(0, newline)));
			buffer = buffer.slice(newline + 1);
			if (record !== undefined) receive(record);
			newline = buffer.indexOf("\n");
		}
	});
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "relay-regression-"));
	const bootstrap = join(directory, "bootstrap.sock");
	const relay = join(directory, "relay.sock");
	const output = join(directory, "output.sock");
	process.env.HERDR_PANE_ID = "relay-test-pane";
	process.env.HERDR_RELAY_BOOTSTRAP_SOCKET = bootstrap;
	await listen(bootstrap, (socket) =>
		lines(socket, () =>
			socket.end(
				`${JSON.stringify({
					type: "credentials",
					key: "test-key-not-a-secret",
					relaySocket: relay,
					writeOutputSocket: output,
				})}\n`,
			),
		),
	);
	await listen(relay, (socket) => {
		relaySocket = socket;
		lines(socket, (record) => {
			if (record.type === "hello") socket.write('{"type":"ready"}\n');
			else events.push(record);
		});
	});
	await listen(output, (socket) => {
		uploadSocket = socket;
		// Consume the upload, but delay the acknowledgement until the test permits it.
		socket.resume();
	});
	const skillPath = join(directory, "SKILL.md");
	await writeFile(skillPath, "---\nname: relay-test\ndescription: test\n---\nSkill body");
	const sourceInfo = {
		path: skillPath,
		source: "test",
		scope: "user",
		origin: "top-level",
	} as const;
	commands = [
		{ name: "reload-runtime", source: "extension", sourceInfo },
		{ name: "danger", source: "extension", sourceInfo },
		{ name: "skill:relay-test", source: "skill", sourceInfo },
	];
	// SAFETY: This injection implements the API members used by the relay. Event
	// handlers are called only with the corresponding Pi event discriminant.
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getCommands: () => commands,
		getSessionName: () => undefined,
		getThinkingLevel: () => "medium",
		sendUserMessage(...args: Parameters<ExtensionAPI["sendUserMessage"]>) {
			messages.push(args);
		},
	} as unknown as ExtensionAPI;
	const { default: extension } = await import("../agent/extensions/web-herdr-relay/index");
	extension(pi);
	await emit({ type: "session_start", reason: "startup" });
	await vi.waitFor(() => expect(events.some((event) => event.type === "snapshot")).toBe(true));
});

afterAll(async () => {
	await emit({ type: "session_shutdown", reason: "quit" });
	for (const socket of sockets) socket.destroy();
	await Promise.all(
		servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await rm(directory, { recursive: true, force: true });
	if (originalPane === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = originalPane;
	if (originalBootstrap === undefined) delete process.env.HERDR_RELAY_BOOTSTRAP_SOCKET;
	else process.env.HERDR_RELAY_BOOTSTRAP_SOCKET = originalBootstrap;
});

async function command(
	content: string,
	kind = "Prompt",
	attachments: Record<string, unknown> = {},
) {
	if (relaySocket === undefined) throw new Error("Relay is not connected");
	const operationId = `operation-${++operation}`;
	relaySocket.write(
		`${JSON.stringify({
			type: "command",
			command: {
				command: kind,
				content,
				operationId,
				paneId: "relay-test-pane",
				...attachments,
			},
		})}\n`,
	);
	await expect
		.poll(() => events.find((event) => event.operationId === operationId)?.status)
		.toBe("ok");
	return messages.at(-1);
}

// Prevent advertised reload commands from becoming model prompts without granting
// command dispatch to arbitrary browser content or expanded skill/upload content.
test("opts only the bare reload invocation into Pi command dispatch", async () => {
	for (const kind of ["Prompt", "Steer", "FollowUp"]) {
		idle = kind === "Prompt";
		expect(await command("/reload-runtime", kind)).toEqual([
			"/reload-runtime",
			{
				expandPromptTemplates: true,
				...(kind === "Prompt" ? {} : { deliverAs: kind === "Steer" ? "steer" : "followUp" }),
			},
		]);
	}
	idle = true;
	for (const text of ["/danger", "/reload-runtime arguments", "/reload-runtime-other"]) {
		expect(await command(text)).toEqual([text, { expandPromptTemplates: false }]);
	}
	const skill = await command("/skill:relay-test do work", "Prompt", {
		files: [
			{
				name: "note.txt",
				path: "/tmp/web-herdr-uploads-test/00000000-0000-0000-0000-000000000000.txt",
			},
		],
	});
	expect(skill?.[0]).toContain("<web-herdr-files>");
	expect(skill?.[0]).toContain("Skill body");
	expect(skill?.[0]).toContain("do work");
	expect(skill?.[1]?.expandPromptTemplates).toBe(false);
	const uploadedReload = await command("/reload-runtime", "Prompt", {
		files: [
			{
				name: "note.txt",
				path: "/tmp/web-herdr-uploads-test/00000000-0000-0000-0000-000000000000.txt",
			},
		],
	});
	expect(uploadedReload?.[0]).toContain("<web-herdr-files>");
	expect(uploadedReload?.[1]?.expandPromptTemplates).toBe(false);
});

function acknowledgeUpload() {
	if (uploadSocket === undefined) throw new Error("Upload is not connected");
	uploadSocket.end('{"type":"stored"}\n');
}

function completed(id: string) {
	return events.flatMap((event) => {
		const tool = asRecord(event.tool);
		return tool?.id === id && tool.status === "complete" ? [tool] : [];
	});
}

// Prevent premature publication of results that a later tool_result handler patches.
test.each([false, true])(
	"publishes one final patched tool result (isError=%s)",
	async (isError) => {
		const toolCallId = `patched-${isError}`;
		await emit({
			type: "tool_result",
			toolCallId,
			toolName: "read",
			input: { path: "file.txt" },
			content: [{ type: "text", text: "unpatched" }],
			details: {},
			isError: !isError,
		});
		await emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "read",
			isError,
			result: { content: [{ type: "text", text: "patched /private/session.jsonl" }], details: {} },
		});
		await expect.poll(() => completed(toolCallId).length).toBe(1);
		expect(completed(toolCallId)[0]).toMatchObject({
			isError,
			input: expect.stringContaining("file.txt"),
		});
		expect(completed(toolCallId)[0]?.detail).not.toContain("/private/session.jsonl");
		expect(completed(toolCallId)[0]?.detail).toContain("patched");
	},
);

// Prevent a provisional successful write from being released before a later failure patch.
test.each([
	{ isError: false, initialError: false },
	{ isError: true, initialError: true },
	{ isError: false, initialError: true },
	{ isError: true, initialError: false },
])(
	"waits for the final write status before upload control ($initialError -> $isError)",
	async ({ isError, initialError }) => {
		uploadSocket = undefined;
		const toolCallId = `write-${initialError}-${isError}`;
		const input = { path: "/tmp/output.txt", content: "private file body" };
		await emit({ type: "tool_execution_start", toolCallId, toolName: "write", args: input });
		await expect.poll(() => uploadSocket !== undefined).toBe(true);
		await emit({
			type: "tool_result",
			toolCallId,
			toolName: "write",
			input,
			content: [{ type: "text", text: "provisional" }],
			details: {},
			isError: initialError,
		});
		await emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "write",
			isError,
			result: { content: [{ type: "text", text: "final" }], details: {} },
		});
		await expect.poll(() => completed(toolCallId).length).toBe(1);
		if (!isError) {
			expect(asRecord(completed(toolCallId)[0]?.writeResult)?.state).toBe("pending");
			acknowledgeUpload();
			await expect.poll(() => completed(toolCallId).length).toBe(2);
		}
		await expect
			.poll(() =>
				events.filter(
					(event) => event.type === "write_output_control" && event.toolCallId === toolCallId,
				),
			)
			.toEqual([expect.objectContaining({ action: isError ? "discard" : "complete" })]);
		expect(asRecord(completed(toolCallId).at(-1)?.writeResult)?.state).toBe(
			isError ? "unavailable" : "available",
		);
		expect(JSON.stringify(completed(toolCallId))).not.toContain(input.content);
	},
);
