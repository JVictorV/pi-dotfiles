import { access } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { env } from "node:process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { LspSpawnError, lspErrorReason, type LspError } from "./errors";
import type { LspConfig, ServerCapabilities, UserServerConfig } from "./types";
import { canonicalPath } from "./paths";

export interface LspSpawnSpec {
	command: string;
	args: ReadonlyArray<string>;
	env?: Readonly<Record<string, string>>;
	initializationOptions?: Readonly<Record<string, unknown>>;
}

export interface LspServerDefinition {
	id: string;
	label: string;
	extensions: ReadonlyArray<string>;
	rootMarkers: ReadonlyArray<string>;
	strictRoot: boolean;
	capabilities: ServerCapabilities;
	installHint: string;
	spawn: (input: ServerSpawnInput) => Effect.Effect<LspSpawnSpec | undefined, LspError>;
}

export interface ServerSpawnInput {
	root: string;
	cwd: string;
	definition: LspServerDefinition;
}

export interface LspServerHandle {
	definition: LspServerDefinition;
	root: string;
	process: ChildProcessWithoutNullStreams;
	initializationOptions?: Readonly<Record<string, unknown>>;
}

const executableExtensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

const canExecute = (path: string): Effect.Effect<boolean> =>
	Effect.tryPromise(() => access(path, constants.X_OK)).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);

const isWithin = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const pathCandidates = (bin: string, dir: string): ReadonlyArray<string> => {
	if (process.platform !== "win32" || parse(bin).ext !== "") return [join(dir, bin)];
	return executableExtensions.map((extension) => join(dir, `${bin}${extension}`));
};

const findInNodeModules = Effect.fn("findInNodeModules")(function* (
	bin: string,
	start: string,
	stop: string,
) {
	let current = start;
	while (isWithin(current, stop)) {
		for (const candidate of pathCandidates(bin, join(current, "node_modules", ".bin"))) {
			if (yield* canExecute(candidate)) return candidate;
		}
		if (current === stop) break;
		const next = dirname(current);
		if (next === current) break;
		current = next;
	}
	return undefined;
});

const findOnPath = Effect.fn("findOnPath")(function* (bin: string) {
	for (const pathEntry of (env.PATH ?? "").split(delimiter)) {
		if (!pathEntry) continue;
		for (const candidate of pathCandidates(bin, pathEntry)) {
			if (yield* canExecute(candidate)) return candidate;
		}
	}
	return undefined;
});

const findInAgentNodeModules = Effect.fn("findInAgentNodeModules")(function* (bin: string) {
	const agentRoot = dirname(getAgentDir());
	return yield* findInNodeModules(bin, agentRoot, agentRoot);
});

export const findExecutable = Effect.fn("findExecutable")(function* (
	bin: string,
	root: string,
	cwd: string,
) {
	if (bin.includes("/") || bin.includes("\\") || isAbsolute(bin)) {
		const resolved = isAbsolute(bin) ? bin : resolve(root, bin);
		return (yield* canExecute(resolved)) ? resolved : undefined;
	}

	return (
		(yield* findInNodeModules(bin, root, cwd)) ??
		(yield* findInNodeModules(bin, cwd, cwd)) ??
		(yield* findInAgentNodeModules(bin)) ??
		(yield* findOnPath(bin))
	);
});

export const resolveNodeModuleFile = Effect.fn("resolveNodeModuleFile")(function* (
	modulePath: string,
	root: string,
	cwd: string,
) {
	let current = root;
	while (isWithin(current, cwd)) {
		const candidate = join(current, "node_modules", ...modulePath.split("/"));
		const exists = yield* Effect.tryPromise(() => access(candidate, constants.F_OK)).pipe(
			Effect.as(true),
			Effect.catch(() => Effect.succeed(false)),
		);
		if (exists) return candidate;
		if (current === cwd) break;
		const next = dirname(current);
		if (next === current) break;
		current = next;
	}
	return undefined;
});

const commandServer = (input: {
	id: string;
	label: string;
	extensions: ReadonlyArray<string>;
	rootMarkers: ReadonlyArray<string>;
	strictRoot?: boolean;
	capabilities?: Partial<ServerCapabilities>;
	bin: string;
	args: ReadonlyArray<string>;
	installHint: string;
	initializationOptions?: (
		input: ServerSpawnInput,
	) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, LspError>;
}): LspServerDefinition => ({
	id: input.id,
	label: input.label,
	extensions: input.extensions,
	rootMarkers: input.rootMarkers,
	strictRoot: input.strictRoot ?? false,
	capabilities: {
		navigation: input.capabilities?.navigation ?? true,
		diagnostics: input.capabilities?.diagnostics ?? true,
	},
	installHint: input.installHint,
	spawn: (spawnInput) =>
		Effect.gen(function* () {
			const command = yield* findExecutable(input.bin, spawnInput.root, spawnInput.cwd);
			if (command === undefined) return undefined;
			return {
				command,
				args: input.args,
				initializationOptions: yield* (
					input.initializationOptions?.(spawnInput) ?? Effect.succeed(undefined)
				),
			};
		}),
});

const nodeMarkers = [
	"package.json",
	"tsconfig.json",
	"jsconfig.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
];

const builtinServers: ReadonlyArray<LspServerDefinition> = [
	commandServer({
		id: "typescript",
		label: "TypeScript",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		rootMarkers: nodeMarkers,
		bin: "typescript-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D typescript typescript-language-server",
		initializationOptions: ({ root, cwd }) =>
			Effect.gen(function* () {
				const tsserver = yield* resolveNodeModuleFile("typescript/lib/tsserver.js", root, cwd);
				return tsserver ? { tsserver: { path: dirname(tsserver) } } : undefined;
			}),
	}),
	commandServer({
		id: "eslint",
		label: "ESLint",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
		rootMarkers: nodeMarkers,
		capabilities: { navigation: false, diagnostics: true },
		bin: "vscode-eslint-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D vscode-langservers-extracted eslint",
	}),
	commandServer({
		id: "json",
		label: "JSON",
		extensions: [".json", ".jsonc"],
		rootMarkers: nodeMarkers,
		bin: "vscode-json-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D vscode-langservers-extracted",
	}),
	commandServer({
		id: "css",
		label: "CSS",
		extensions: [".css", ".scss", ".less"],
		rootMarkers: nodeMarkers,
		bin: "vscode-css-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D vscode-langservers-extracted",
	}),
	commandServer({
		id: "html",
		label: "HTML",
		extensions: [".html", ".htm"],
		rootMarkers: nodeMarkers,
		bin: "vscode-html-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D vscode-langservers-extracted",
	}),
	commandServer({
		id: "pyright",
		label: "Pyright",
		extensions: [".py", ".pyi"],
		rootMarkers: [
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"pyrightconfig.json",
		],
		bin: "pyright-langserver",
		args: ["--stdio"],
		installHint: "Install with: npm install -D pyright or pipx install pyright",
	}),
	commandServer({
		id: "rust-analyzer",
		label: "Rust Analyzer",
		extensions: [".rs"],
		rootMarkers: ["Cargo.toml"],
		strictRoot: true,
		bin: "rust-analyzer",
		args: [],
		installHint: "Install rust-analyzer with rustup or your package manager.",
	}),
	commandServer({
		id: "gopls",
		label: "gopls",
		extensions: [".go"],
		rootMarkers: ["go.mod", "go.work"],
		bin: "gopls",
		args: [],
		installHint: "Install with: go install golang.org/x/tools/gopls@latest",
	}),
	commandServer({
		id: "bash-language-server",
		label: "Bash Language Server",
		extensions: [".sh", ".bash", ".zsh"],
		rootMarkers: [".git"],
		bin: "bash-language-server",
		args: ["start"],
		installHint: "Install with: npm install -D bash-language-server",
	}),
	commandServer({
		id: "vue",
		label: "Vue Language Server",
		extensions: [".vue"],
		rootMarkers: nodeMarkers,
		bin: "vue-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D @vue/language-server typescript",
	}),
	commandServer({
		id: "svelte",
		label: "Svelte Language Server",
		extensions: [".svelte"],
		rootMarkers: ["svelte.config.js", "svelte.config.mjs", ...nodeMarkers],
		bin: "svelteserver",
		args: ["--stdio"],
		installHint: "Install with: npm install -D svelte-language-server typescript",
	}),
	commandServer({
		id: "astro",
		label: "Astro Language Server",
		extensions: [".astro"],
		rootMarkers: ["astro.config.mjs", "astro.config.js", "astro.config.ts", ...nodeMarkers],
		bin: "astro-ls",
		args: ["--stdio"],
		installHint: "Install with: npm install -D @astrojs/language-server typescript",
	}),
	commandServer({
		id: "tailwindcss",
		label: "Tailwind CSS Language Server",
		extensions: [
			".html",
			".htm",
			".css",
			".scss",
			".less",
			".ts",
			".tsx",
			".js",
			".jsx",
			".vue",
			".svelte",
			".astro",
		],
		rootMarkers: [
			"tailwind.config.js",
			"tailwind.config.cjs",
			"tailwind.config.mjs",
			"tailwind.config.ts",
		],
		strictRoot: true,
		bin: "tailwindcss-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D @tailwindcss/language-server",
	}),
	commandServer({
		id: "clangd",
		label: "clangd",
		extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", ".git"],
		bin: "clangd",
		args: [],
		installHint: "Install clangd with your system package manager or LLVM tools.",
	}),
	commandServer({
		id: "lua-language-server",
		label: "Lua Language Server",
		extensions: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc", ".git"],
		bin: "lua-language-server",
		args: [],
		installHint: "Install lua-language-server with your system package manager.",
	}),
	commandServer({
		id: "terraform-ls",
		label: "Terraform LS",
		extensions: [".tf", ".tfvars"],
		rootMarkers: [".terraform", ".terraform.lock.hcl", ".git"],
		bin: "terraform-ls",
		args: ["serve"],
		installHint: "Install terraform-ls from HashiCorp releases or your package manager.",
	}),
	commandServer({
		id: "dockerfile-language-server",
		label: "Dockerfile Language Server",
		extensions: ["Dockerfile", ".dockerfile"],
		rootMarkers: ["Dockerfile", ".git"],
		bin: "docker-langserver",
		args: ["--stdio"],
		installHint: "Install with: npm install -D dockerfile-language-server-nodejs",
	}),
	commandServer({
		id: "yaml",
		label: "YAML",
		extensions: [".yaml", ".yml"],
		rootMarkers: [".git", "package.json"],
		bin: "yaml-language-server",
		args: ["--stdio"],
		installHint: "Install with: npm install -D yaml-language-server",
	}),
];

const mergeServerConfig = (
	definition: LspServerDefinition | undefined,
	serverId: string,
	config: UserServerConfig,
) => {
	if (config.disabled) return undefined;
	if (definition === undefined && config.command === undefined) return undefined;

	const base: LspServerDefinition = definition ?? {
		id: serverId,
		label: serverId,
		extensions: [],
		rootMarkers: [".git"],
		strictRoot: false,
		capabilities: { navigation: true, diagnostics: true },
		installHint: `Configure agent/lsp.json server ${serverId}.command`,
		spawn: () => Effect.succeed(undefined),
	};

	return {
		...base,
		extensions: config.extensions ?? base.extensions,
		rootMarkers: config.rootMarkers ?? base.rootMarkers,
		strictRoot: config.strictRoot ?? base.strictRoot,
		capabilities: {
			navigation: config.capabilities?.navigation ?? base.capabilities.navigation,
			diagnostics: config.capabilities?.diagnostics ?? base.capabilities.diagnostics,
		},
		spawn: (input: ServerSpawnInput) =>
			Effect.gen(function* () {
				if (config.command === undefined) return yield* base.spawn(input);
				const [bin, ...args] = config.command;
				if (bin === undefined) return undefined;
				const command = yield* findExecutable(bin, input.root, input.cwd);
				if (command === undefined) return undefined;
				return { command, args, env: config.env };
			}),
	} satisfies LspServerDefinition;
};

export const buildServerRegistry = (
	config: LspConfig,
): ReadonlyMap<string, LspServerDefinition> => {
	const registry = new Map<string, LspServerDefinition>();
	for (const server of builtinServers) {
		registry.set(server.id, server);
	}

	for (const [serverId, serverConfig] of Object.entries(config.servers)) {
		const merged = mergeServerConfig(registry.get(serverId), serverId, serverConfig);
		if (merged === undefined) {
			registry.delete(serverId);
			continue;
		}
		registry.set(serverId, merged);
	}

	return registry;
};

export const findServerRoot = Effect.fn("findServerRoot")(function* (
	file: string,
	cwd: string,
	definition: LspServerDefinition,
) {
	let current = dirname(yield* canonicalPath(file));
	const stop = yield* canonicalPath(cwd);

	while (isWithin(current, stop)) {
		for (const marker of definition.rootMarkers) {
			const markerPath = join(current, marker);
			const exists = yield* Effect.tryPromise(() => access(markerPath, constants.F_OK)).pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (exists) return current;
		}

		if (current === stop) break;
		const next = dirname(current);
		if (next === current) break;
		current = next;
	}

	return definition.strictRoot ? undefined : stop;
});

export const matchesExtension = (definition: LspServerDefinition, file: string): boolean => {
	const lowerFile = file.toLowerCase();
	return definition.extensions.some((extension) => lowerFile.endsWith(extension.toLowerCase()));
};

export const spawnServer = Effect.fn("spawnServer")(function* (
	definition: LspServerDefinition,
	root: string,
	cwd: string,
) {
	const spec = yield* definition.spawn({ root, cwd, definition });
	if (spec === undefined) return undefined;

	return yield* Effect.try({
		try: () => ({
			definition,
			root,
			process: spawn(spec.command, [...spec.args], {
				cwd: root,
				env: { ...env, ...spec.env },
				stdio: ["pipe", "pipe", "pipe"],
			}),
			initializationOptions: spec.initializationOptions,
		}),
		catch: (error) =>
			LspSpawnError.make({
				serverId: definition.id,
				reason: lspErrorReason(error, `Failed to spawn ${definition.id}`),
			}),
	});
});

export const displayRoot = (root: string, cwd: string): string => {
	const rel = relative(cwd, root);
	return rel === "" ? "." : rel.split(sep).join("/");
};
