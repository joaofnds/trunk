/// <reference types="vitest/config" />

import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/postcss";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	css: {
		postcss: {
			// Scan only the frontend tree for class candidates — the repo root
			// also holds src-tauri/target, which is not source and is huge.
			plugins: [
				tailwindcss({ base: new URL("./src", import.meta.url).pathname }),
			],
		},
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
		watch: {
			ignored: ["**/src-tauri/**", "**/.boris/**"],
		},
		// `just measure` serves the measurement page from this same server, so
		// proxying the host bridge keeps the page same-origin with it. Nothing
		// listens on 8732 during an ordinary `just dev`, where the route is
		// simply never requested.
		proxy: {
			"/bridge": {
				target: "http://127.0.0.1:8732",
				rewrite: (path) => path.replace(/^\/bridge/, ""),
			},
		},
	},
	test: {
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
		environment: "jsdom",
		setupFiles: ["./vitest-setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "html"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.ts", "src/**/*.svelte"],
			exclude: ["src/**/*.test.ts"],
			// Floors sit just under the measured numbers so they catch a
			// regression, not ordinary churn. Raise them when they get slack.
			thresholds: {
				statements: 57,
				branches: 45,
				functions: 55,
				lines: 55,
			},
		},
	},
});
