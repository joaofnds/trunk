import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "vite";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("the macOS production startup bundle", () => {
	it("starts after its mount element and opens a deferred view", async () => {
		vi.stubEnv("TAURI_ENV_PLATFORM", "darwin");
		const root = await mkdtemp(join(tmpdir(), "trunk-startup-bundle-"));
		let dom: JSDOM | undefined;
		onTestFinished(async () => {
			try {
				dom?.window.close();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		await Promise.all([
			writeFile(
				join(root, "index.html"),
				'<html><head></head><body><div id="app"></div><button id="open">Open</button><script type="module" src="/main.js"></script></body></html>',
			),
			writeFile(
				join(root, "main.js"),
				`import "./main.css";
const target = document.getElementById("app");
target.textContent = "Ready";
document.body.dataset.starts = String(Number(document.body.dataset.starts ?? 0) + 1);
document.getElementById("open").addEventListener("click", async () => {
    const { open } = await import("./panel.js");
    open(target);
    window.dispatchEvent(new Event("panel-ready"));
});`,
			),
			writeFile(join(root, "main.css"), "#app { color: rgb(1, 2, 3); }"),
			writeFile(
				join(root, "panel.js"),
				`export function open(target) { target.textContent = "Panel"; }`,
			),
		]);

		await build({
			configFile: resolve("vite.config.ts"),
			root,
			base: "./",
			logLevel: "silent",
		});
		const index = join(root, "dist/index.html");
		const errors: Error[] = [];
		const console = new VirtualConsole();
		console.on("jsdomError", (error) => errors.push(error));
		dom = new JSDOM(await readFile(index, "utf8"), {
			url: pathToFileURL(index).href,
			resources: "usable",
			runScripts: "dangerously",
			virtualConsole: console,
		});
		const { window } = dom;
		await new Promise<void>((resolve) =>
			window.addEventListener("load", () => resolve(), { once: true }),
		);

		const target = window.document.getElementById("app");
		if (!target) throw new Error("Missing fixture mount element");

		expect(errors).toEqual([]);
		expect(target?.textContent).toBe("Ready");
		expect(window.document.body.dataset.starts).toBe("1");
		expect(window.getComputedStyle(target).color).toBe("rgb(1, 2, 3)");

		const button = window.document.getElementById("open");
		if (!button) throw new Error("Missing fixture open button");

		const opened = new Promise<void>((resolve) =>
			window.addEventListener("panel-ready", () => resolve(), { once: true }),
		);
		button.click();
		await opened;

		expect(target?.textContent).toBe("Panel");
		expect(window.document.body.dataset.starts).toBe("1");
	});
});
