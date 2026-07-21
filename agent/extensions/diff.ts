/**
 * Hunk diff command extension.
 *
 * Registers `/diff` to open Hunk in a focused Herdr pane or tab.
 */

import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Effect, Option, Schema } from "effect";

const HERDR_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LENGTH = 1_000;

class DiffCommandError extends Schema.TaggedErrorClass<DiffCommandError>()("DiffCommandError", {
	operation: Schema.String,
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

const CreatedPaneResponse = Schema.Struct({
	result: Schema.Struct({
		pane: Schema.Struct({
			pane_id: Schema.NonEmptyString,
		}),
	}),
}).pipe(Schema.fromJsonString);

const CreatedTabResponse = Schema.Struct({
	result: Schema.Struct({
		root_pane: Schema.Struct({
			pane_id: Schema.NonEmptyString,
		}),
		tab: Schema.Struct({
			tab_id: Schema.NonEmptyString,
		}),
	}),
}).pipe(Schema.fromJsonString);

const decodeCreatedPaneResponse = Schema.decodeUnknownEffect(CreatedPaneResponse);
const decodeCreatedTabResponse = Schema.decodeUnknownEffect(CreatedTabResponse);

const HerdrConfiguration = Config.all({
	environment: Config.string("HERDR_ENV").pipe(Config.withDefault("")),
	paneId: Config.option(Config.string("HERDR_PANE_ID")),
	socketPath: Config.option(Config.string("HERDR_SOCKET_PATH")),
	workspaceId: Config.option(Config.string("HERDR_WORKSPACE_ID")),
});

type DiffPlacement = "pane" | "tab";

interface HerdrContext {
	readonly paneId: string;
	readonly workspaceId: Option.Option<string>;
}

interface HunkDestination {
	readonly paneId: string;
	readonly cleanupOperation: string;
	readonly cleanupArgs: ReadonlyArray<string>;
}

const diffCommandError = (operation: string, message: string, cause: unknown): DiffCommandError =>
	DiffCommandError.make({ operation, message, cause });

const diffCommandErrorMessage = (failure: DiffCommandError): string => failure.message;

const truncateDiagnostic = (diagnostic: string): string => {
	const trimmed = diagnostic.trim();
	if (trimmed.length <= MAX_DIAGNOSTIC_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`;
};

const commandFailureMessage = (operation: string, result: ExecResult): string => {
	const diagnostic = truncateDiagnostic(
		[result.stderr, result.stdout].filter((part) => part.trim().length > 0).join("\n"),
	);
	const outcome = result.killed ? "was terminated" : `exited with code ${result.code}`;
	return `${operation} ${outcome}${diagnostic ? `: ${diagnostic}` : ""}`;
};

const runHerdr = Effect.fn("Diff.runHerdr")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	operation: string,
	args: ReadonlyArray<string>,
) {
	const result = yield* Effect.tryPromise({
		try: () =>
			pi.exec("herdr", [...args], {
				cwd: ctx.cwd,
				timeout: HERDR_TIMEOUT_MS,
			}),
		catch: (cause) => diffCommandError(operation, `${operation} could not start`, cause),
	});

	if (result.code !== 0 || result.killed) {
		return yield* diffCommandError(operation, commandFailureMessage(operation, result), result);
	}
	return result;
});

const readHerdrContext = (): Effect.Effect<HerdrContext, DiffCommandError> =>
	HerdrConfiguration.pipe(
		Effect.mapError((cause) =>
			diffCommandError("Reading Herdr configuration", "Could not read Herdr configuration", cause),
		),
		Effect.flatMap((configuration) => {
			if (
				configuration.environment !== "1" ||
				Option.isNone(configuration.socketPath) ||
				Option.isNone(configuration.paneId)
			) {
				return Effect.fail(
					diffCommandError(
						"Reading Herdr configuration",
						"/diff requires Pi to be running in a Herdr-managed pane",
						configuration,
					),
				);
			}
			return Effect.succeed({
				paneId: configuration.paneId.value,
				workspaceId: configuration.workspaceId,
			});
		}),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
	);

const parseCreatedPane = (stdout: string): Effect.Effect<HunkDestination, DiffCommandError> =>
	decodeCreatedPaneResponse(stdout).pipe(
		Effect.map((response) => ({
			paneId: response.result.pane.pane_id,
			cleanupOperation: "Cleaning up the Hunk pane",
			cleanupArgs: ["pane", "close", response.result.pane.pane_id],
		})),
		Effect.mapError((cause) =>
			diffCommandError(
				"Decoding Herdr pane response",
				"Herdr returned an invalid response while creating the Hunk pane",
				cause,
			),
		),
	);

const parseCreatedTab = (stdout: string): Effect.Effect<HunkDestination, DiffCommandError> =>
	decodeCreatedTabResponse(stdout).pipe(
		Effect.map((response) => ({
			paneId: response.result.root_pane.pane_id,
			cleanupOperation: "Cleaning up the Hunk tab",
			cleanupArgs: ["tab", "close", response.result.tab.tab_id],
		})),
		Effect.mapError((cause) =>
			diffCommandError(
				"Decoding Herdr tab response",
				"Herdr returned an invalid response while creating the Hunk tab",
				cause,
			),
		),
	);

const closeDestinationBestEffort = (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	destination: HunkDestination,
): Effect.Effect<void> =>
	runHerdr(pi, ctx, destination.cleanupOperation, destination.cleanupArgs).pipe(
		Effect.catch(() => Effect.void),
		Effect.asVoid,
	);

const createHunkPane = Effect.fn("Diff.createHunkPane")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	herdr: HerdrContext,
) {
	const split = yield* runHerdr(pi, ctx, "Creating the Hunk pane", [
		"pane",
		"split",
		"--pane",
		herdr.paneId,
		"--direction",
		"right",
		"--cwd",
		ctx.cwd,
		"--focus",
	]);
	return yield* parseCreatedPane(split.stdout);
});

const createHunkTab = Effect.fn("Diff.createHunkTab")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	herdr: HerdrContext,
) {
	if (Option.isNone(herdr.workspaceId)) {
		return yield* diffCommandError(
			"Reading Herdr configuration",
			"Herdr did not provide the current workspace required by /diff tab",
			herdr,
		);
	}

	const created = yield* runHerdr(pi, ctx, "Creating the Hunk tab", [
		"tab",
		"create",
		"--workspace",
		herdr.workspaceId.value,
		"--cwd",
		ctx.cwd,
		"--focus",
	]);
	return yield* parseCreatedTab(created.stdout);
});

const openHunkDiff = Effect.fn("Diff.openHunkDiff")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	placement: DiffPlacement,
) {
	const herdr = yield* readHerdrContext();
	const destination = yield* placement === "tab"
		? createHunkTab(pi, ctx, herdr)
		: createHunkPane(pi, ctx, herdr);

	yield* runHerdr(pi, ctx, "Starting Hunk", [
		"pane",
		"run",
		destination.paneId,
		"exec hunk diff",
	]).pipe(Effect.onError(() => closeDestinationBestEffort(pi, ctx, destination)));

	return destination.paneId;
});

/**
 * Register the `/diff` command.
 *
 * @param pi - The Pi extension API.
 */
export default function diffExtension(pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Open the working tree diff in Hunk",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			return "tab".startsWith(normalized) ? [{ value: "tab", label: "tab" }] : null;
		},
		handler: async (args, ctx) => {
			const normalized = args.trim().toLowerCase();
			const placement: DiffPlacement | undefined =
				normalized === "" ? "pane" : normalized === "tab" ? "tab" : undefined;
			if (placement === undefined) {
				ctx.ui.notify("Usage: /diff [tab]", "warning");
				return;
			}

			await Effect.runPromise(
				openHunkDiff(pi, ctx, placement).pipe(
					Effect.catchTag("DiffCommandError", (error) =>
						Effect.sync(() => ctx.ui.notify(diffCommandErrorMessage(error), "error")),
					),
				),
			);
		},
	});
}
