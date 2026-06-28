import { defineConfig } from "oxlint";
import { strict } from "effect-rules/configs";

export default defineConfig({
	plugins: ["typescript", "unicorn", "oxc"],
	categories: {
		correctness: "error",
	},
	jsPlugins: ["effect-rules"],
	rules: {
		...strict.rules,
	},
	env: {
		node: true,
		builtin: true,
	},
	ignorePatterns: [
		"node_modules/**",
		".repos/**",
		"agent/npm/**",
		"agent/bin/**",
		"agent/sessions/**",
		"agent/extensions/herdr-agent-state.ts",
		// Vendored from dmmulroy's dotfiles; linted upstream, kept faithful for re-sync.
		"agent/extensions/web-tools/**",
	],
});
