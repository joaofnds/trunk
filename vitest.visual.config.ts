import { defineConfig } from "vitest/config";

// The visual suite: the real application in Playwright's WebKit, its commit
// graph captured and compared with committed baselines (docs/visual-regression.md).
// The suite serves the page itself, so this config needs no Svelte plugin.
export default defineConfig({
	test: {
		include: ["tests/visual/**/*.test.ts"],
		environment: "node",
		testTimeout: 20_000,
		hookTimeout: 60_000,
	},
});
