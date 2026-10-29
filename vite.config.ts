/// <reference types="vitest/config" />

import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/postcss";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig, type Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const macOSBundle = env.TAURI_ENV_PLATFORM === "darwin";
const classicStartup: Plugin = {
	name: "classic-startup",
	apply: "build",
	transformIndexHtml: {
		order: "post",
		handler(html, { chunk }) {
			if (!chunk) return html;

			// Vite puts even an IIFE entry in a module script in the head.
			const entry = [
				...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g),
			].find((script) => script[1].endsWith(`/${chunk.fileName}`));
			if (!entry) throw new Error("Missing production entry script");

			return {
				html: html.replace(entry[0], ""),
				tags: [{ tag: "script", attrs: { src: entry[1] }, injectTo: "body" }],
			};
		},
	},
};

// The drive build's folder picker (src/drive-dialog.ts).
const driveDialog = fileURLToPath(
	new URL("./src/drive-dialog.ts", import.meta.url),
);
const driveOpenPanel: Plugin = {
	name: "drive-open-panel",
	apply: "build",
	enforce: "pre",
	resolveId(source, importer) {
		if (source !== "@tauri-apps/plugin-dialog" || importer === driveDialog) {
			return null;
		}
		return driveDialog;
	},
};
const driveBuild = env.VITE_TRUNK_DRIVE === "1";

export default defineConfig({
	plugins: [
		svelte(),
		svelteTesting(),
		macOSBundle && classicStartup,
		driveBuild && driveOpenPanel,
	],
	build: macOSBundle
		? {
				cssCodeSplit: false,
				modulePreload: false,
				rolldownOptions: {
					output: {
						format: "iife",
						codeSplitting: false,
						// Deferred view callbacks run after document.currentScript clears.
						intro: "const __trunkEntryUrl = document.currentScript.src;",
					},
					transform: {
						define: {
							"import.meta.resolve": "undefined",
							"import.meta.url": "__trunkEntryUrl",
						},
					},
				},
			}
		: undefined,
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
		// jsdom lays nothing out, but it does cascade declared values, so a component's
		// own stylesheet has to be injected for getComputedStyle to see rules that
		// live in a `<style>` block rather than an inline `style` attribute.
		css: { include: [/\.svelte/] },
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
