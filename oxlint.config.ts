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
	overrides: [
		{
			// Plain Vitest integration tests, not Effect domain code.
			files: ["**/*.test.ts"],
			rules: {
				"effect/no-vitest-import": "off",
				"effect/no-process-env": "off",
				"effect/no-raw-throw": "off",
				"effect/no-try-catch": "off",
				"effect/no-timer-api-in-effect": "off",
				"effect/no-type-casting": "off",
			},
		},
		{
			// SAFETY: HERDR_ENV is a process-boundary capability flag that must be
			// re-read on every call; Effect ConfigProvider.fromEnv snapshots env when
			// the provider is created, which is wrong for /reload and tests.
			files: ["agent/extensions/herdr-subagent/herdr-cli.ts"],
			rules: { "effect/no-process-env": "off" },
		},
		{
			// SAFETY: casesHandled is a plain panic helper for impossible branches.
			// Throwing is intentional per AGENTS.md for violated internal invariants;
			// returning an Effect failure would weaken exhaustiveness and hiding the
			// defect in an infinite loop would silently hang the process.
			files: ["agent/extensions/herdr-subagent/prelude.ts"],
			rules: { "effect/no-raw-throw": "off" },
		},
		{
			// SAFETY: pi types CompactOptions.onError as (error: Error) => void, so
			// error.message is statically Error, not unknown. This is plain pi
			// extension glue rendering a UI notification, not Effect domain code
			// with typed failure channels.
			files: ["agent/extensions/auto-compact.ts"],
			rules: { "effect/no-unknown-error-message": "off" },
		},
		{
			// SAFETY: StatusLineStateStore writes values through the same typed
			// StatusLineStateKey id; getStatusLineState falls back to key.initial for
			// missing values. TypeScript cannot express this dependent map invariant.
			files: ["agent/extensions/statusline/core/state.ts"],
			rules: { "effect/no-type-casting": "off" },
		},
	],
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
