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
				// jsdom's cascade walks @import and @media blocks and no other grouping
				// rule (lib/jsdom/living/css/helpers/computed-style.js, jsdom 30.0.1),
				// so a utility left inside Tailwind's @layer never reaches
				// getComputedStyle. Lifting the layers keeps source order, which in the
				// app sheet is also layer order.
				{
					postcssPlugin: "lift-layers",
					AtRule: {
						layer(rule) {
							if (rule.nodes) rule.replaceWith(rule.nodes);
							else rule.remove();
						},
					},
				},
			],
		},
	},
	test: {
		include: ["tests/app/**/*.test.ts"],
		environment: "jsdom",
		// Inject every component's stylesheet, and the app sheet that carries the
		// utilities, so getComputedStyle can answer which elements scroll. jsdom lays
		// nothing out, but it does cascade declared values, and a scroll container
		// is a declared value.
		css: { include: [/\.svelte/, /src\/app\.css$/] },
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
