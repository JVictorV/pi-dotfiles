import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, type Effect } from "effect";
import type { Diagnostic } from "vscode-languageserver-types";

import type {
	ClientResolution,
	LocatedClient,
	LspCapability,
	LspRuntimeStatus,
} from "./runtime-types";

export class LspRuntimeSession extends Context.Service<
	LspRuntimeSession,
	{
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
>()("pi/lsp/LspRuntimeSession") {}
