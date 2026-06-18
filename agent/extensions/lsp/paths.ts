import { realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { LspPermission } from "./types";

export const configPath = (): string => join(getAgentDir(), "lsp.json");
export const permissionPath = (): string => join(getAgentDir(), "lsp-permissions.json");

export const canonicalPath = (path: string): Effect.Effect<string> => {
	const resolved = resolve(path);
	return Effect.tryPromise(() => realpath(resolved)).pipe(
		Effect.catch(() => Effect.succeed(resolved)),
	);
};

export const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (cwd: string) {
	let current = yield* canonicalPath(cwd);
	const root = parse(current).root;

	while (true) {
		const gitPath = join(current, ".git");
		const hasGit = yield* Effect.tryPromise(() => realpath(gitPath)).pipe(
			Effect.as(true),
			Effect.catch(() => Effect.succeed(false)),
		);
		if (hasGit) return current;

		if (current === root) return yield* canonicalPath(cwd);

		current = dirname(current);
	}
});

export const formatPermission = (permission: LspPermission | undefined): string =>
	permission ?? "unset";
