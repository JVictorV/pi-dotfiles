import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { permissionPath } from "./paths";
import type { LspPermission, LspPermissionFile } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isPermission = (value: unknown): value is LspPermission =>
	value === "allow" || value === "deny";

const emptyPermissionFile = (): LspPermissionFile => ({ version: 1, repos: {} });

const parsePermissionFile = (value: unknown): LspPermissionFile => {
	if (!isRecord(value)) {
		throw new Error("agent/lsp-permissions.json must contain a JSON object");
	}
	if (value.version !== 1) {
		throw new Error("agent/lsp-permissions.json has an unsupported version");
	}
	if (!isRecord(value.repos)) {
		throw new Error("agent/lsp-permissions.json field repos must be an object");
	}

	const repos: Record<string, Record<string, LspPermission>> = {};
	for (const [repoRoot, repoPermissions] of Object.entries(value.repos)) {
		if (!isRecord(repoPermissions)) {
			throw new Error(`agent/lsp-permissions.json repo ${repoRoot} must be an object`);
		}

		const permissions: Record<string, LspPermission> = {};
		for (const [serverId, permission] of Object.entries(repoPermissions)) {
			if (!isPermission(permission)) {
				throw new Error(
					`agent/lsp-permissions.json permission ${repoRoot}.${serverId} must be allow or deny`,
				);
			}
			permissions[serverId] = permission;
		}
		repos[repoRoot] = permissions;
	}

	return { version: 1, repos };
};

export class LspPermissionStore {
	private file: LspPermissionFile;

	private constructor(file: LspPermissionFile) {
		this.file = file;
	}

	static async load(): Promise<LspPermissionStore> {
		const path = permissionPath();
		const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});

		if (text === undefined) {
			return new LspPermissionStore(emptyPermissionFile());
		}

		return new LspPermissionStore(parsePermissionFile(JSON.parse(text)));
	}

	get(repoRoot: string, serverId: string): LspPermission | undefined {
		return this.file.repos[repoRoot]?.[serverId];
	}

	entries(repoRoot: string): ReadonlyArray<readonly [string, LspPermission]> {
		return Object.entries(this.file.repos[repoRoot] ?? {}).sort(([left], [right]) =>
			left.localeCompare(right),
		);
	}

	async set(repoRoot: string, serverId: string, permission: LspPermission): Promise<void> {
		this.file.repos[repoRoot] = {
			...this.file.repos[repoRoot],
			[serverId]: permission,
		};
		await this.save();
	}

	async reset(repoRoot: string, serverId?: string): Promise<void> {
		if (serverId === undefined) {
			delete this.file.repos[repoRoot];
			await this.save();
			return;
		}

		const repo = this.file.repos[repoRoot];
		if (repo !== undefined) {
			delete repo[serverId];
			if (Object.keys(repo).length === 0) {
				delete this.file.repos[repoRoot];
			}
		}

		await this.save();
	}

	private async save(): Promise<void> {
		const path = permissionPath();
		await mkdir(dirname(path), { recursive: true });
		const tmpPath = `${path}.${process.pid}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(this.file, null, "\t")}\n`, "utf8");
		await rename(tmpPath, path);
	}
}
