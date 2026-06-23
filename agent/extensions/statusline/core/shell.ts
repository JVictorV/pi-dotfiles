import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context, Effect } from "effect";

import { statusLineError, unknownReason, type StatusLineError } from "./error";

/** Result of a status-line subprocess. Non-zero exit codes are expected values. */
export type StatusLineExecResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

/** Small shell capability used by status-line data sources. */
export type StatusLineShellService = {
	/** Execute a command with a timeout, failing only when spawning/execution rejects. */
	exec(
		cmd: string,
		args: ReadonlyArray<string>,
		timeoutMs: number,
	): Effect.Effect<StatusLineExecResult, StatusLineError>;
};

/** Effect service tag for shell execution. */
export class StatusLineShell extends Context.Service<
	StatusLineShell,
	{
		/** Execute a command with a timeout, failing only when spawning/execution rejects. */
		exec(
			cmd: string,
			args: ReadonlyArray<string>,
			timeoutMs: number,
		): Effect.Effect<StatusLineExecResult, StatusLineError>;
	}
>()("pi/statusline/StatusLineShell") {}

/** Build the shell service from pi's extension API. */
export const makeStatusLineShell = (pi: ExtensionAPI): StatusLineShellService => ({
	exec: (cmd, args, timeoutMs) =>
		Effect.tryPromise({
			try: async () => {
				const result = await pi.exec(cmd, [...args], { timeout: timeoutMs });
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					code: result.code,
				} satisfies StatusLineExecResult;
			},
			catch: (cause) =>
				statusLineError(cmd, `${cmd} exec failed: ${unknownReason(cause, "unknown")}`),
		}),
});
