/// <reference types="vitest/config" />

import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [svelte(), svelteTesting(), tailwindcss()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
		watch: {
			ignored: ["**/src-tauri/**", "**/.boris/**"],
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
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
