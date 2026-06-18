import { realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { LspPermission } from "./types";

export const configPath = (): string => join(getAgentDir(), "lsp.json");
export const permissionPath = (): string => join(getAgentDir(), "lsp-permissions.json");

export const canonicalPath = async (path: string): Promise<string> => {
	const resolved = resolve(path);
	return realpath(resolved).catch(() => resolved);
};

export const findRepositoryRoot = async (cwd: string): Promise<string> => {
	let current = await canonicalPath(cwd);
	const root = parse(current).root;

	while (true) {
		const gitPath = join(current, ".git");
		try {
			await realpath(gitPath);
			return current;
		} catch {
			// Keep walking upward.
		}

		if (current === root) {
			return await canonicalPath(cwd);
		}

		current = dirname(current);
	}
};

export const formatPermission = (permission: LspPermission | undefined): string =>
	permission ?? "unset";
