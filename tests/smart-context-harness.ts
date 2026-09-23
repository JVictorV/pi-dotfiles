import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type AssistantMessage,
	type Context,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
	type ExtensionError,
} from "@earendil-works/pi-coding-agent";

/** One completed model response. Metadata defaults are deterministic and cost-free. */
export type ScriptedResponse =
	| string
	| {
			readonly content: AssistantMessage["content"];
			readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
			readonly usage?: AssistantMessage["usage"];
			readonly errorMessage?: string;
	  };

/** Supply a finite response script or a custom, local stream implementation. */
export type SmartContextHarnessOptions = {
	readonly extension: ExtensionFactory;
	readonly sessionFile?: string;
	readonly contextWindow?: number;
	readonly compaction?: {
		readonly enabled: boolean;
		readonly reserveTokens?: number;
		readonly keepRecentTokens?: number;
	};
} & (
	| { readonly responses: readonly ScriptedResponse[]; readonly streamFn?: never }
	| { readonly streamFn: StreamFunction<string, SimpleStreamOptions>; readonly responses?: never }
);

/** A real Pi session with isolated resources and snapshots of model request contexts. */
export type SmartContextHarness = {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly capturedContexts: readonly Context[];
	readonly extensionErrors: readonly ExtensionError[];
	/** Abort work, emit session_shutdown, and remove only this harness's temporary files. */
	readonly dispose: () => Promise<void>;
};

/**
 * Create a persistent Pi session without user resource discovery or model network requests.
 * Built-in tools are disabled; tools registered by the supplied extension remain available.
 * Custom streams and extension code must also avoid network calls and external credentials.
 */
export async function createSmartContextHarness(
	options: SmartContextHarnessOptions,
): Promise<SmartContextHarness> {
	// Use the home cache because /tmp can have a separate, exhausted quota.
	const cache = join(homedir(), ".cache", "pi-smart-context-tests");
	await mkdir(cache, { recursive: true });
	const root = await mkdtemp(join(cache, "session-"));
	let session: AgentSession | undefined;
	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		try {
			if (session) {
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			}
		} finally {
			session?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	};

	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory({
			compaction: options.compaction ?? { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const capturedContexts: Context[] = [];
		let responseIndex = 0;
		const streamFn: StreamFunction<string, SimpleStreamOptions> = (
			model,
			context,
			streamOptions,
		) => {
			// AgentTool objects also carry execute functions. Capture only the model-facing schema.
			capturedContexts.push(
				structuredClone({
					...context,
					tools: context.tools?.map(({ name, description, parameters, constrainedSampling }) => ({
						name,
						description,
						parameters,
						constrainedSampling,
					})),
				}),
			);
			if (options.streamFn) return options.streamFn(model, context, streamOptions);
			const response = options.responses[responseIndex++];
			if (response === undefined)
				throw new Error("Smart context harness response script exhausted");
			const script =
				typeof response === "string"
					? { content: [{ type: "text" as const, text: response }] }
					: response;
			const message: AssistantMessage = {
				role: "assistant",
				content: structuredClone(script.content),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: script.usage ?? {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason:
					script.stopReason ??
					(script.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
				timestamp: responseIndex,
				...(script.errorMessage === undefined ? {} : { errorMessage: script.errorMessage }),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (message.stopReason !== "pending") {
				stream.push({
					type: "done",
					reason: message.stopReason,
					message,
				});
			}
			return stream;
		};
		modelRuntime.registerProvider("smart-context-test", {
			baseUrl: "http://smart-context-test.invalid",
			apiKey: "test-only-not-a-credential",
			api: "openai-completions",
			streamSimple: streamFn,
			models: [
				{
					id: "scripted",
					name: "Scripted test model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: options.contextWindow ?? 128000,
					maxTokens: 4096,
				},
			],
		});
		const model = modelRuntime.getModel("smart-context-test", "scripted");
		if (!model) throw new Error("Smart context harness model was not registered");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [options.extension],
			systemPrompt: "You are a deterministic test assistant.",
		});
		await resourceLoader.reload();
		if (resourceLoader.getExtensions().errors.length > 0) {
			throw new Error("Smart context harness extension failed to load");
		}
		const sessionManager = options.sessionFile
			? SessionManager.open(options.sessionFile, join(root, "sessions"))
			: SessionManager.create(cwd, join(root, "sessions"));
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			resourceLoader,
			sessionManager,
			settingsManager,
			thinkingLevel: "off",
			noTools: "builtin",
		}));
		const extensionErrors: ExtensionError[] = [];
		const activeSession = session;
		const unsupported = async (): Promise<never> => {
			throw new Error("Session replacement is not supported by this test harness");
		};
		await session.bindExtensions({
			mode: "print",
			onError: (error) => {
				extensionErrors.push(error);
			},
			commandContextActions: {
				waitForIdle: () => activeSession.waitForIdle(),
				newSession: unsupported,
				fork: unsupported,
				switchSession: unsupported,
				navigateTree: (id, options) => activeSession.navigateTree(id, options),
				reload: unsupported,
			},
		});
		return { session, sessionManager, capturedContexts, extensionErrors, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
