import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/postcss";
import { type Browser, type Page, webkit } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { HostClient } from "../app/harness/host-client.js";
import type { Difference } from "./baseline.js";
import "./page/bindings.js";

const ROOT = join(import.meta.dirname, "../..");
const PAGE = "/tests/visual/page/index.html";
const DEFAULT_FIXTURES = "src-tauri/target/debug/fixtures";

/** The cases whose repositories carry a commit graph worth a baseline. */
const GRAPH_CASES = ["graph-lanes", "graph-merges"];

/** The window every capture is taken in, and the day its relative dates count from. */
const VIEWPORT = { width: 1200, height: 800 };
const NOW = new Date("2026-09-01T00:00:00Z");

/** Captures that differ this many times running mean the page never settled. */
const SETTLE_ATTEMPTS = 5;

/** Pages capturing at once. Each capture mostly waits on its host and its page,
 *  so a few overlap well; more would load a machine other sessions share. */
const PAGES = pageCount(process.env.TRUNK_VISUAL_PAGES ?? "3");

export interface GraphView {
	/** Sizes the graph column as a user dragging it would, in CSS pixels. */
	graphColumnWidth?: number;
}

/**
 * The real application, served by Vite to Playwright's WebKit, reading
 * repositories built by the fixture crate through a real host. A few pages
 * capture at once, each borrowed by one capture at a time.
 */
export class VisualHarness {
	private readonly idle: AppPage[];
	private readonly waiting: ((page: AppPage) => void)[] = [];

	private constructor(
		private readonly repos: string,
		private readonly vite: ViteDevServer,
		private readonly browser: Browser,
		private readonly pages: AppPage[],
	) {
		this.idle = [...pages];
	}

	static async setup(): Promise<VisualHarness> {
		const repos = mkdtempSync(join(tmpdir(), "trunk-visual-"));
		const started = await Promise.allSettled([
			buildFixtures(repos),
			serve(),
			webkit.launch(),
		]);
		const [fixtures, vite, browser] = started;
		if (
			fixtures.status === "rejected" ||
			vite.status === "rejected" ||
			browser.status === "rejected"
		) {
			// Whatever did start would otherwise outlive the failed run.
			if (vite.status === "fulfilled") await vite.value.close();
			if (browser.status === "fulfilled") await browser.value.close();
			rmSync(repos, { recursive: true, force: true });
			const failed = started.find((result) => result.status === "rejected");
			throw (failed as PromiseRejectedResult).reason;
		}

		const url = new URL(PAGE, origin(vite.value)).href;
		const pages = await Promise.all(
			Array.from({ length: PAGES }, () => AppPage.open(browser.value, url)),
		);

		return new VisualHarness(repos, vite.value, browser.value, pages);
	}

	/** Every repository the graph cases built, as `case/repository`. The bare
	 *  remotes some cases push to sit in a dot directory and are no graph. */
	graphRepositories(): string[] {
		return GRAPH_CASES.flatMap((graphCase) =>
			readdirSync(join(this.repos, graphCase))
				.filter((name) => !name.startsWith("."))
				.map((name) => `${graphCase}/${name}`),
		).sort();
	}

	/** Opens `repository` the way a restored tab does and captures the graph pane. */
	async captureGraph(
		repository: string,
		view: GraphView = {},
	): Promise<Buffer> {
		const page = await this.borrow();
		try {
			return await page.captureGraph(join(this.repos, repository), view);
		} finally {
			this.giveBack(page);
		}
	}

	/** Decodes both images in the browser and counts the pixels whose colour differs. */
	async difference(baseline: Buffer, capture: Buffer): Promise<Difference> {
		const page = await this.browser.newPage();
		try {
			const { pixels, image } = await page.evaluate(comparePixels, [
				baseline.toString("base64"),
				capture.toString("base64"),
			] as const);
			return { pixels, image: Buffer.from(image, "base64") };
		} finally {
			await page.close();
		}
	}

	async teardown(): Promise<void> {
		await Promise.all(this.pages.map((page) => page.close()));
		await this.browser.close();
		await this.vite.close();
		rmSync(this.repos, { recursive: true, force: true });
	}

	private borrow(): Promise<AppPage> {
		const page = this.idle.pop();
		if (page) return Promise.resolve(page);

		return new Promise((lend) => this.waiting.push(lend));
	}

	private giveBack(page: AppPage): void {
		const next = this.waiting.shift();
		if (next) next(page);
		else this.idle.push(page);
	}
}

/**
 * One browser page and the host behind it. The host is replaced for every
 * capture: it keeps the prefs the application writes, and a capture that
 * inherited another's would depend on the order they ran in.
 */
class AppPage {
	private host: HostClient | null = null;

	private constructor(
		private readonly page: Page,
		private readonly url: string,
	) {}

	static async open(browser: Browser, url: string): Promise<AppPage> {
		const page = await browser.newPage({
			viewport: VIEWPORT,
			deviceScaleFactor: 1,
		});
		await page.clock.setFixedTime(NOW);

		const appPage = new AppPage(page, url);
		await appPage.bind();
		return appPage;
	}

	async captureGraph(path: string, view: GraphView): Promise<Buffer> {
		await this.replaceHost();
		await this.openTab(path, view);

		await this.page.goto(this.url);
		await this.page.waitForFunction(
			() => document.querySelector(".overlay-paths path") !== null,
		);

		return this.settledCapture();
	}

	async close(): Promise<void> {
		await this.host?.shutdown();
		await this.page.close();
	}

	private async bind(): Promise<void> {
		await this.page.exposeFunction(
			"__trunkInvoke",
			(cmd: string, args: Record<string, unknown>) =>
				this.currentHost().invoke(cmd, args),
		);
		await this.page.exposeFunction(
			"__trunkHome",
			() => this.currentHost().home,
		);
		await this.page.addInitScript(() => {
			const queued: [string, unknown][] = [];
			let deliver: ((event: string, payload: unknown) => void) | null = null;

			window.__trunkPending = 0;
			window.__trunkOnEvent = (handler) => {
				deliver = handler;
				for (const [event, payload] of queued.splice(0))
					handler(event, payload);
			};
			window.__trunkDeliver = (event, payload) => {
				if (deliver) deliver(event, payload);
				else queued.push([event, payload]);
			};
		});
	}

	private async replaceHost(): Promise<void> {
		await this.host?.shutdown();

		const host = await HostClient.spawn();
		host.onEvent((event, payload) => {
			if (this.host !== host) return;
			void this.page
				.evaluate(([e, p]) => window.__trunkDeliver(e, p), [
					event,
					payload,
				] as const)
				.catch(() => {});
		});
		this.host = host;
	}

	private async openTab(path: string, view: GraphView): Promise<void> {
		const host = this.currentHost();
		const name = basename(path);
		const prefs: Record<string, unknown> = {
			open_tabs: [{ id: "visual", repoPath: path, repoName: name }],
			active_tab_id: "visual",
			recent_repos: [{ name, path }],
		};
		if (view.graphColumnWidth !== undefined) {
			prefs.column_widths = { graph: view.graphColumnWidth };
			prefs.resized_columns = ["graph"];
		}

		for (const [key, value] of Object.entries(prefs))
			await host.invoke("prefs_set", { key, value });
	}

	/**
	 * A capture taken once nothing is owed by the host and two frames have
	 * painted, repeated until two in a row are identical. A stored column width
	 * arrives by a round trip after the first rails draw, so the first capture
	 * can precede it, which is also why the column is measured on every attempt.
	 */
	private async settledCapture(): Promise<Buffer> {
		let previous: Buffer | null = null;

		for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
			await this.page.waitForFunction(() => window.__trunkPending === 0);
			await this.page.evaluate(
				() =>
					new Promise((painted) =>
						requestAnimationFrame(() => requestAnimationFrame(painted)),
					),
			);
			const capture = await this.page.screenshot({
				clip: await this.page.evaluate(graphColumn),
				animations: "disabled",
			});
			if (previous?.equals(capture)) return capture;
			previous = capture;
		}

		throw new Error(
			`the graph kept changing across ${SETTLE_ATTEMPTS} captures; the page never settled`,
		);
	}

	private currentHost(): HostClient {
		if (this.host === null)
			throw new Error("no host: capture a repository first");
		return this.host;
	}
}

/**
 * The graph column of the commit list: as wide as its header cell and as tall
 * as the list. Nothing outside it is captured, so a change to another column
 * leaves every capture as it was.
 */
function graphColumn(): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const list = document.querySelector('[role="listbox"]:has(.overlay-paths)');
	const header = document.querySelector(
		"[data-testid=column-header] > [data-column=graph]",
	);
	if (list === null || header === null)
		throw new Error("the commit list or its graph column is not on the page");

	const rows = list.getBoundingClientRect();
	const column = header.getBoundingClientRect();
	return {
		x: column.left,
		y: rows.top,
		width: column.width,
		height: rows.height,
	};
}

function pageCount(setting: string): number {
	const pages = Number(setting);
	if (!Number.isInteger(pages) || pages < 1)
		throw new Error(
			`TRUNK_VISUAL_PAGES must be a whole number of at least 1, not "${setting}"`,
		);
	return pages;
}

function origin(vite: ViteDevServer): string {
	const address = vite.httpServer?.address();
	if (address === null || address === undefined || typeof address === "string")
		throw new Error("the Vite server is not listening on a port");
	return `http://127.0.0.1:${address.port}`;
}

async function comparePixels([baseline, capture]: readonly [
	string,
	string,
]): Promise<{ pixels: number; image: string }> {
	const decode = async (png: string) => {
		const image = new Image();
		image.src = `data:image/png;base64,${png}`;
		await image.decode();
		return image;
	};
	const [expected, actual] = await Promise.all([
		decode(baseline),
		decode(capture),
	]);
	const width = Math.max(expected.width, actual.width);
	const height = Math.max(expected.height, actual.height);
	const pixelsOf = (image: HTMLImageElement) => {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext(
			"2d",
		) as OffscreenCanvasRenderingContext2D;
		context.drawImage(image, 0, 0);
		return context.getImageData(0, 0, width, height).data;
	};
	const before = pixelsOf(expected);
	const after = pixelsOf(actual);

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
	const out = context.createImageData(width, height);
	let pixels = 0;
	for (let i = 0; i < before.length; i += 4) {
		const differs =
			before[i] !== after[i] ||
			before[i + 1] !== after[i + 1] ||
			before[i + 2] !== after[i + 2] ||
			before[i + 3] !== after[i + 3];
		if (differs) pixels++;
		const grey = (before[i] + before[i + 1] + before[i + 2]) / 12 + 191;
		out.data[i] = differs ? 255 : grey;
		out.data[i + 1] = differs ? 0 : grey;
		out.data[i + 2] = differs ? 0 : grey;
		out.data[i + 3] = 255;
	}
	context.putImageData(out, 0, 0);

	const blob = await canvas.convertToBlob({ type: "image/png" });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return { pixels, image: btoa(binary) };
}

async function buildFixtures(out: string): Promise<void> {
	const binary = process.env.TRUNK_FIXTURES ?? join(ROOT, DEFAULT_FIXTURES);
	await promisify(execFile)(binary, ["build", ...GRAPH_CASES, "--out", out]);
}

async function serve(): Promise<ViteDevServer> {
	const server = await createServer({
		configFile: false,
		root: ROOT,
		logLevel: "error",
		plugins: [svelte()],
		css: {
			postcss: {
				plugins: [tailwindcss({ base: join(ROOT, "src") })],
			},
		},
		server: {
			host: "127.0.0.1",
			port: 0,
			hmr: false,
			watch: null,
		},
	});
	return server.listen();
}
