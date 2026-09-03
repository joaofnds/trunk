/// <reference types="vitest/config" />

import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/postcss";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite";

// The application harness suite: the real Svelte tree in jsdom, `invoke` routed
// to a real Rust host. Separate from `vite.config.ts` so `just vitest` never
// waits on a Rust artifact and the harness stays out of the frontend coverage
// denominator.
export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	css: {
		postcss: {
			plugins: [
				tailwindcss({ base: new URL("./src", import.meta.url).pathname }),
			],
		},
	},
	test: {
		include: ["tests/app/**/*.test.ts"],
		environment: "jsdom",
		// Inject every component's stylesheet so getComputedStyle can answer which
		// elements scroll. jsdom lays nothing out, but it does cascade declared
		// values, and a scroll container is a declared value.
		css: { include: [/\.svelte/] },
		// Every worker compiles the whole Svelte tree, and that compile is most of
		// the suite's wall time. Threads share it where the default forks pool does
		// not: dropping back to forks costs 1.8 s of the 10 s ceiling.
		pool: "threads",
		// Booting the real application costs far more than a component mount, and
		// the 5 000 ms default silently killed a round of the grill's measurements.
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
