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
