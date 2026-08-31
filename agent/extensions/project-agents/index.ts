import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Config, Effect, FileSystem, ManagedRuntime, Option, Result } from "effect";

import {
	locateProjectInstructions,
	type ProjectInstructionsLocation,
	type ProjectInstructionsStorageError,
	readProjectInstructions,
	removeProjectInstructions,
	writeProjectInstructions,
} from "./storage";

type CommandAction = "edit" | "path" | "remove";
const COMMAND_ACTIONS: ReadonlyArray<CommandAction> = ["edit", "path", "remove"];

const COMMAND_COMPLETIONS: ReadonlyArray<AutocompleteItem> = COMMAND_ACTIONS.map((action) => ({
	value: action,
	label: action,
}));

// The Node filesystem layer is stateless. A shared runtime avoids rebuilding the
// layer for each prompt while remaining safe across extension reloads.
const storageRuntime = ManagedRuntime.make(NodeFileSystem.layer);

const storageRootConfig = Effect.gen(function* () {
	const override = yield* Config.option(Config.string("PI_PROJECT_AGENTS_DIR"));
	if (Option.isSome(override) && isAbsolute(override.value)) return resolve(override.value);

	const xdgDataHome = yield* Config.option(Config.string("XDG_DATA_HOME"));
	const dataHome =
		Option.isSome(xdgDataHome) && isAbsolute(xdgDataHome.value)
			? xdgDataHome.value
			: join(homedir(), ".local", "share");
	return join(dataHome, "pi", "project-agents");
});

const runStorage = <A>(
	program: Effect.Effect<A, ProjectInstructionsStorageError, FileSystem.FileSystem>,
): Promise<Result.Result<A, ProjectInstructionsStorageError>> =>
	storageRuntime.runPromise(Effect.result(program));

const parseAction = (input: string): CommandAction | undefined => {
	const normalized = input.trim().toLowerCase();
	if (!normalized) return "edit";
	return COMMAND_ACTIONS.find((action) => action === normalized);
};

const notifyStorageFailure = (
	ctx: ExtensionContext,
	error: ProjectInstructionsStorageError,
): void => {
	ctx.ui.notify(error.reason, "error");
};

/**
 * Append private project instructions to the current system prompt.
 *
 * @param systemPrompt - Pi's current chained system prompt.
 * @param instructions - The private Markdown instructions.
 * @returns The prompt with non-empty private instructions appended.
 */
export function appendPrivateProjectInstructions(
	systemPrompt: string,
	instructions: string,
): string {
	const normalized = instructions.trim();
	if (!normalized) return systemPrompt;
	return `${systemPrompt}\n\n# Private Project Instructions\n\n${normalized}\n`;
}

/**
 * Stop the turn when configured private instructions cannot be loaded safely.
 *
 * @param systemPrompt - Pi's current chained system prompt.
 * @returns The prompt with a user-visible failure instruction.
 */
export function appendPrivateProjectInstructionsFailure(systemPrompt: string): string {
	return `${systemPrompt}\n\n# Private Project Instructions Unavailable\n\nStop. Tell the user that Pi could not safely load the private project instructions. Do not continue the requested task until the storage error is fixed.\n`;
}

/**
 * Register private per-project `AGENTS.md` support.
 *
 * Instructions are stored outside repositories under the user's data directory.
 * Use `/project-agents` to edit the current project's file.
 *
 * @param pi - The pi extension API.
 */
export default async function (pi: ExtensionAPI) {
	const storageRoot = await Effect.runPromise(storageRootConfig);
	let cachedLocation:
		| { readonly cwd: string; readonly value: ProjectInstructionsLocation }
		| undefined;
	let lastReportedReadFailure: string | undefined;

	const getLocation = async (
		cwd: string,
	): Promise<Result.Result<ProjectInstructionsLocation, ProjectInstructionsStorageError>> => {
		if (cachedLocation?.cwd === cwd) return Result.succeed(cachedLocation.value);

		const outcome = await runStorage(locateProjectInstructions(cwd, storageRoot));
		if (Result.isSuccess(outcome)) cachedLocation = { cwd, value: outcome.success };
		return outcome;
	};

	const editInstructions = async (
		location: ProjectInstructionsLocation,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Private project instructions: ${location.instructionsFile}`, "info");
			return;
		}

		const readOutcome = await runStorage(readProjectInstructions(location));
		if (Result.isFailure(readOutcome)) {
			notifyStorageFailure(ctx, readOutcome.failure);
			return;
		}

		const initial = Option.getOrElse(readOutcome.success, () => "");
		const edited = await ctx.ui.editor("Private project instructions", initial);
		if (edited === undefined) return;

		if (!edited.trim()) {
			const removeOutcome = await runStorage(removeProjectInstructions(location));
			if (Result.isFailure(removeOutcome)) {
				notifyStorageFailure(ctx, removeOutcome.failure);
				return;
			}
			ctx.ui.notify("Private project instructions removed", "info");
			return;
		}

		const writeOutcome = await runStorage(writeProjectInstructions(location, edited));
		if (Result.isFailure(writeOutcome)) {
			notifyStorageFailure(ctx, writeOutcome.failure);
			return;
		}
		ctx.ui.notify(`Private project instructions saved to ${location.instructionsFile}`, "info");
	};

	const removeInstructions = async (
		location: ProjectInstructionsLocation,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const readOutcome = await runStorage(readProjectInstructions(location));
		if (Result.isFailure(readOutcome)) {
			notifyStorageFailure(ctx, readOutcome.failure);
			return;
		}
		if (Option.isNone(readOutcome.success)) {
			ctx.ui.notify("No private project instructions exist for this project", "info");
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify("Removing private project instructions requires an interactive UI", "warning");
			return;
		}

		const confirmed = await ctx.ui.confirm(
			"Remove private project instructions?",
			location.instructionsFile,
		);
		if (!confirmed) return;

		const removeOutcome = await runStorage(removeProjectInstructions(location));
		if (Result.isFailure(removeOutcome)) {
			notifyStorageFailure(ctx, removeOutcome.failure);
			return;
		}
		ctx.ui.notify("Private project instructions removed", "info");
	};

	pi.registerCommand("project-agents", {
		description: "Edit private per-project instructions stored outside the repository",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			const action = parseAction(args);
			if (action === undefined) {
				ctx.ui.notify(`Usage: /project-agents [${COMMAND_ACTIONS.join("|")}]`, "warning");
				return;
			}

			const locationOutcome = await getLocation(ctx.cwd);
			if (Result.isFailure(locationOutcome)) {
				notifyStorageFailure(ctx, locationOutcome.failure);
				return;
			}

			switch (action) {
				case "edit":
					await editInstructions(locationOutcome.success, ctx);
					return;
				case "path":
					ctx.ui.notify(locationOutcome.success.instructionsFile, "info");
					return;
				case "remove":
					await removeInstructions(locationOutcome.success, ctx);
					return;
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const locationOutcome = await getLocation(ctx.cwd);
		if (Result.isFailure(locationOutcome)) {
			if (lastReportedReadFailure !== locationOutcome.failure.reason) {
				notifyStorageFailure(ctx, locationOutcome.failure);
				lastReportedReadFailure = locationOutcome.failure.reason;
			}
			return {
				systemPrompt: appendPrivateProjectInstructionsFailure(event.systemPrompt),
			};
		}

		const readOutcome = await runStorage(readProjectInstructions(locationOutcome.success));
		if (Result.isFailure(readOutcome)) {
			if (lastReportedReadFailure !== readOutcome.failure.reason) {
				notifyStorageFailure(ctx, readOutcome.failure);
				lastReportedReadFailure = readOutcome.failure.reason;
			}
			return {
				systemPrompt: appendPrivateProjectInstructionsFailure(event.systemPrompt),
			};
		}

		lastReportedReadFailure = undefined;
		if (Option.isNone(readOutcome.success) || !readOutcome.success.value.trim()) return;

		return {
			systemPrompt: appendPrivateProjectInstructions(event.systemPrompt, readOutcome.success.value),
		};
	});
}
