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
		// Booting the real application costs far more than a component mount, and
		// the 5 000 ms default silently killed a round of the grill's measurements.
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
