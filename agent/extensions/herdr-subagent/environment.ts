import { ConfigProvider } from "effect";

/** Snapshot this process's configuration for one extension runtime. */
export const configurationProvider = (): ConfigProvider.ConfigProvider =>
	ConfigProvider.fromEnv({
		// Select process values explicitly. Bundlers can replace import.meta.env
		// with a build-time snapshot, which must not override the live socket path.
		env: Object.fromEntries(
			Object.entries(globalThis.process.env).flatMap(([key, value]) =>
				value === undefined ? [] : [[key, value]],
			),
		),
	});

/** Return whether this process is running inside a herdr-managed session. */
export const isRunningInsideHerdr = (): boolean => globalThis.process?.env["HERDR_ENV"] === "1";

/** Return whether this pi process is itself a spawned herdr subagent. */
export const isHerdrSubagentSession = (): boolean =>
	globalThis.process?.env["HERDR_SUBAGENT_NAME"] !== undefined;

/** Return whether this spawned subagent session may recursively spawn subagents. */
export const isHerdrSubagentSpawnAllowed = (): boolean =>
	globalThis.process?.env["HERDR_SUBAGENT_ALLOW_SPAWN"] === "1";

/** Return the configured subagent name for this pi process, if any. */
export const herdrSubagentName = (): string | undefined =>
	globalThis.process?.env["HERDR_SUBAGENT_NAME"];

/** Return the orchestrator result socket path passed to this subagent, if any. */
export const herdrSubagentResultSocket = (): string | undefined =>
	globalThis.process?.env["HERDR_SUBAGENT_RESULT_SOCK"];
