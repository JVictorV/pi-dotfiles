import { Deferred } from "effect";

import type { LspClient } from "./client";
import type { LspServerDefinition } from "./server";

export interface RuntimeState {
	clients: Map<string, LspClient>;
	clientDefinitions: Map<string, LspServerDefinition>;
	broken: Map<string, string>;
	spawning: Map<string, Deferred.Deferred<LspClient | undefined, unknown>>;
	shuttingDown: boolean;
	activeOperations: number;
	disposeRequested: boolean;
	disposed: boolean;
}

export const makeRuntimeState = (): RuntimeState => ({
	clients: new Map(),
	clientDefinitions: new Map(),
	broken: new Map(),
	spawning: new Map(),
	shuttingDown: false,
	activeOperations: 0,
	disposeRequested: false,
	disposed: false,
});
