import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "agent/extensions/**/*.test.ts"],
		exclude: [".repos/**", "node_modules/**"],
		testTimeout: 15_000,
		hookTimeout: 15_000,
	},
});
