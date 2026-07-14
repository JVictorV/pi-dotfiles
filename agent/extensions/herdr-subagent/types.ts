import type { TextContent } from "@earendil-works/pi-ai";
import type { Schema } from "effect";

import type { ModelRegistryForResolution } from "./model-resolver";
import type { HerdrAgent, RegistryEntrySchema } from "./schemas";

export type HerdrSubagentAction =
	| "status"
	| "agent-types"
	| "spawn"
	| "inspect"
	| "send"
	| "wait"
	| "focus"
	| "close";
export type PaneReadSource = "visible" | "recent" | "recent-unwrapped";
export type WaitStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type AgentScope = "user" | "project" | "both";
export type SpawnIsolation = "worktree";
/**
 * The thinking levels a herdr subagent may be spawned with.
 *
 * `off`/`minimal` stay banned — they are wrong for autonomous agents. `xhigh`
 * is allowed so implementation/diagnosis roles can run at the effort DeepSWE
 * quality was benchmarked at (`[max]`); reasoning tokens are a small cost
 * slice and higher effort tends to reduce turn count (the cache-read driver).
 */
export type SubagentThinking = "low" | "medium" | "high" | "xhigh";

export const ACTIONS: ReadonlyArray<HerdrSubagentAction> = [
	"status",
	"agent-types",
	"spawn",
	"inspect",
	"send",
	"wait",
	"focus",
	"close",
];
export const SOURCES: ReadonlyArray<PaneReadSource> = ["visible", "recent", "recent-unwrapped"];
export const WAIT_STATUSES: ReadonlyArray<WaitStatus> = [
	"idle",
	"working",
	"blocked",
	"done",
	"unknown",
];
export const AGENT_SCOPES: ReadonlyArray<AgentScope> = ["user", "project", "both"];
export const SPAWN_ISOLATIONS: ReadonlyArray<SpawnIsolation> = ["worktree"];
export const SUBAGENT_THINKING_LEVELS: ReadonlyArray<SubagentThinking> = [
	"low",
	"medium",
	"high",
	"xhigh",
];

/**
 * Check whether a string is an allowed subagent thinking level.
 *
 * @param value - The thinking level to check.
 * @returns True when the value is a permitted subagent thinking level.
 */
export const isSubagentThinking = (value: string): value is SubagentThinking =>
	SUBAGENT_THINKING_LEVELS.some((level) => level === value);

export interface HerdrSubagentParams {
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
	readonly isolation?: SpawnIsolation;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly allowSpawn?: boolean;
	readonly message?: string;
	readonly lines?: number;
	readonly source?: PaneReadSource;
	readonly status?: WaitStatus;
	readonly timeoutMs?: number;
	readonly notify?: boolean;
}

export interface CommandSuccess {
	readonly stdout: string;
	readonly stderr: string;
}

export type RegistryEntry = Schema.Schema.Type<typeof RegistryEntrySchema>;

export interface AgentDefinition {
	readonly name: string;
	readonly description: string;
	readonly tools?: ReadonlyArray<string>;
	readonly allowSpawn?: boolean;
	readonly model?: string;
	readonly thinking?: string;
	readonly systemPrompt: string;
	readonly source: "user" | "project";
	readonly filePath: string;
}

export interface AgentDiscovery {
	readonly agents: ReadonlyArray<AgentDefinition>;
	readonly projectAgentsDir: string | null;
}

export interface ResolvedPane {
	readonly name: string;
	readonly paneId: string;
	readonly liveAgent?: HerdrAgent;
}

export interface ToolResult {
	readonly content: TextContent[];
	readonly details: unknown;
	readonly isError?: boolean;
}

export interface PiToolContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui: { confirm(title: string, message: string): Promise<boolean> };
	readonly modelRegistry?: ModelRegistryForResolution;
}
