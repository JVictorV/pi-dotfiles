import type { TextContent } from "@earendil-works/pi-ai";
import type { Schema } from "effect";

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
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly message?: string;
	readonly lines?: number;
	readonly source?: PaneReadSource;
	readonly status?: WaitStatus;
	readonly timeoutMs?: number;
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
}
