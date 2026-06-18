import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";
import type { Diagnostic } from "vscode-languageserver-types";

import type { LspClient, LspClientStatus } from "./client";
import type { LspServerDefinition } from "./server";

export type LspCapability = "navigation" | "diagnostics";

export interface LocatedClient {
	client: LspClient;
	definition: LspServerDefinition;
}

export interface LspRuntimeStatus extends LspClientStatus {
	displayRoot: string;
}

export interface LspUnavailable {
	serverId: string;
	reason: string;
}

export interface ClientResolution {
	clients: ReadonlyArray<LocatedClient>;
	unavailable: ReadonlyArray<LspUnavailable>;
}

export interface LspRuntimeSessionShape {
	serverIds: Effect.Effect<ReadonlyArray<string>>;
	status: Effect.Effect<ReadonlyArray<LspRuntimeStatus>>;
	runningClients(capability: LspCapability): Effect.Effect<ReadonlyArray<LocatedClient>>;
	diagnostics(file?: string): Effect.Effect<ReadonlyMap<string, ReadonlyArray<Diagnostic>>>;
	restart(serverId?: string): Effect.Effect<void, unknown>;
	shutdown: Effect.Effect<void, unknown>;
	clientsForFile(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Effect.Effect<ClientResolution, unknown>;
	touchRunningFile(filePath: string): Effect.Effect<void, unknown>;
}
