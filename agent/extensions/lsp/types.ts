export const LSP_PERMISSION_VALUES: readonly ["allow", "deny"] = ["allow", "deny"];

export type LspPermission = (typeof LSP_PERMISSION_VALUES)[number];

export interface ServerCapabilities {
	navigation: boolean;
	diagnostics: boolean;
}

export interface UserServerConfig {
	disabled?: boolean;
	command?: ReadonlyArray<string>;
	env?: Readonly<Record<string, string>>;
	extensions?: ReadonlyArray<string>;
	rootMarkers?: ReadonlyArray<string>;
	strictRoot?: boolean;
	capabilities?: Partial<ServerCapabilities>;
}

export interface LspConfig {
	servers: Readonly<Record<string, UserServerConfig>>;
}

export interface LspPermissionFile {
	version: 1;
	repos: Record<string, Record<string, LspPermission>>;
}
