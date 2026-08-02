// Adapted from https://github.com/tauri-apps/webdriver-example/blob/main/v2/webdriver/webdriverio/wdio.conf.js

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let tauriDriver;
let exit = false;

// Only `just e2e-build` writes this target dir, and it always bakes the e2e
// app identifier (tauri.e2e.conf.json) — so a binary at this path can never
// carry the installed app's identifier and clobber its settings.
const binaryPath = path.resolve(
	__dirname,
	"../src-tauri/target/e2e/debug/trunk",
);

export const config = {
	host: "127.0.0.1",
	port: 4444,
	specs: ["./specs/**/*.e2e.js"],
	maxInstances: 1,
	capabilities: [
		{
			maxInstances: 1,
			"tauri:options": {
				application: binaryPath,
			},
		},
	],
	reporters: ["spec"],
	// The suite only runs in CI (macOS has no WebDriver), so a failure is only as
	// debuggable as what the workflow can upload afterwards.
	outputDir: path.resolve(__dirname, "logs"),
	framework: "mocha",
	mochaOpts: {
		ui: "bdd",
		timeout: 60000,
	},

	// Build the debug binary before any test runs (E2E_SKIP_BUILD skips the
	// build when a previously built binary exists)
	onPrepare: () => {
		if (process.env.E2E_SKIP_BUILD && existsSync(binaryPath)) {
			console.log("Skipping build (E2E_SKIP_BUILD is set)");
		} else {
			console.log("Building debug binary...");
			const result = spawnSync("just", ["e2e-build"], {
				cwd: path.resolve(__dirname, ".."),
				stdio: "inherit",
				shell: true,
			});
			if (result.status !== 0) {
				throw new Error(`Build failed with exit code ${result.status}`);
			}
		}

		if (!existsSync(binaryPath)) {
			throw new Error(`Binary not found at ${binaryPath}`);
		}
	},

	// Start tauri-driver before each session
	beforeSession: () => {
		tauriDriver = spawn(
			path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"),
			[],
			{ stdio: [null, process.stdout, process.stderr] },
		);

		tauriDriver.on("error", (error) => {
			console.error("tauri-driver error:", error);
			process.exit(1);
		});

		tauriDriver.on("exit", (code) => {
			if (!exit) {
				console.error("tauri-driver exited with code:", code);
				process.exit(1);
			}
		});
	},

	afterSession: () => {
		closeTauriDriver();
	},
};

function closeTauriDriver() {
	exit = true;
	tauriDriver?.kill();
}

function onShutdown(fn) {
	const cleanup = () => {
		try {
			fn();
		} finally {
			process.exit();
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("SIGHUP", cleanup);
	process.on("SIGBREAK", cleanup);
}

onShutdown(() => {
	closeTauriDriver();
});
