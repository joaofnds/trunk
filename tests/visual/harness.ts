import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type Browser, type Page, webkit } from "playwright";
import {
	createServer,
	loadConfigFromFile,
	type PluginOption,
	type ViteDevServer,
} from "vite";
import { HostClient } from "../app/harness/host-client.js";
import type { Difference } from "./baseline.js";
import "./page/bindings.js";

const ROOT = join(import.meta.dirname, "../..");
const PAGE = "/tests/visual/page/index.html";
const DEFAULT_FIXTURES = "src-tauri/target/debug/fixtures";

/** Sets up vitest's DOM tests, and inside any vitest process it empties Vite's
 *  browser resolve conditions, so the page would load Svelte's server build. */
const UNIT_TEST_PLUGIN = "vite-plugin-svelte-testing-library";

/** The cases whose repositories carry a commit graph worth a baseline. */
const GRAPH_CASES = ["graph-lanes", "graph-merges"];

/** The window every capture is taken in, tall enough to hold the longest graph
 *  without scrolling, and the day its relative dates count from. */
const VIEWPORT = { width: 1200, height: 1000 };
const NOW = new Date("2026-09-01T00:00:00Z");

/** How many levels of 255 a pixel's channel may move before the pixel differs.
 *  GitHub's macOS runner draws a diagonal rail up to 12 levels away from this
 *  Mac, and an erased rail moves at least 96 pixels per capture by more than 64. */
const CHANNEL_TOLERANCE = 24;

/** Captures that differ this many times running mean the page never settled. */
const SETTLE_ATTEMPTS = 5;

/** How long a repository may take to draw its first row. It sits inside the
 *  test's timeout so the failure can carry what the host was still owed. */
const ROWS_DRAWN_MS = 10_000;

/** Pages capturing at once. Each capture mostly waits on its host and its page,
 *  so a few overlap well. vitest runs at most five tests at once, so a sixth
 *  page would never be borrowed (docs/visual-regression.md). */
const PAGES = pageCount(process.env.TRUNK_VISUAL_PAGES ?? "5");

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
	private readonly waiting: ((page: AppPage) => void)[] = [];

	private constructor(
		private readonly repos: string,
		private readonly browser: Browser,
		private readonly idle: AppPage[],
		private readonly opened: Opened,
	) {}

	static async setup(): Promise<VisualHarness> {
		const opened = new Opened();
		try {
			return await VisualHarness.start(opened);
		} catch (error) {
			try {
				await opened.close();
			} catch (closing) {
				throw new AggregateError(
					[error, closing],
					"the visual harness did not start, and did not close",
				);
			}
			throw error;
		}
	}

	/** The fixture build takes longest, so the pages open and load the app beside it. */
	private static async start(opened: Opened): Promise<VisualHarness> {
		const repos = mkdtempSync(join(tmpdir(), "trunk-visual-"));
		opened.add(() => rmSync(repos, { recursive: true, force: true }));

		const [fixtures, browsing] = await Promise.allSettled([
			buildFixtures(repos),
			VisualHarness.openPages(opened),
		]);
		if (fixtures.status === "rejected") throw fixtures.reason;
		if (browsing.status === "rejected") throw browsing.reason;

		const { browser, pages } = browsing.value;
		return new VisualHarness(repos, browser, pages, opened);
	}

	private static async openPages(
		opened: Opened,
	): Promise<{ browser: Browser; pages: AppPage[] }> {
		const [vite, browser] = await Promise.allSettled([serve(), launchWebKit()]);
		if (vite.status === "fulfilled") opened.add(() => vite.value.close());
		if (browser.status === "fulfilled") opened.add(() => browser.value.close());
		if (vite.status === "rejected") throw vite.reason;
		if (browser.status === "rejected") throw browser.reason;

		// A page that opened before another failed closes with the browser.
		const url = new URL(PAGE, origin(vite.value)).href;
		const pages = await Promise.all(
			Array.from({ length: PAGES }, () => AppPage.open(browser.value, url)),
		);
		for (const page of pages) opened.add(() => page.close());

		return { browser: browser.value, pages };
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

	/** Opens `repository` the way a restored tab does and captures the graph column. */
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

	/** Decodes both images in the browser and counts the pixels with a channel
	 *  more than `CHANNEL_TOLERANCE` levels from the baseline's. */
	async difference(baseline: Buffer, capture: Buffer): Promise<Difference> {
		const page = await this.browser.newPage();
		try {
			const { pixels, image } = await page.evaluate(comparePixels, [
				baseline.toString("base64"),
				capture.toString("base64"),
				CHANNEL_TOLERANCE,
			] as const);
			return { pixels, image: Buffer.from(image, "base64") };
		} finally {
			await page.close();
		}
	}

	async teardown(): Promise<void> {
		await this.opened.close();
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
		// Puts the app's modules in the page's cache before the first capture.
		// With no host attached, the app stops booting at its first question.
		await page.goto(url);
		return appPage;
	}

	async captureGraph(path: string, view: GraphView): Promise<Buffer> {
		await this.retireHost();
		const host = await this.attachHost();
		await this.openTab(path, view);

		await this.page.goto(this.url);
		await this.untilRowsDrawn(host);

		return this.settledCapture();
	}

	async close(): Promise<void> {
		const retired = this.host;
		this.host = null;
		await retired?.shutdown();

		await this.page.close();
	}

	/** A document that asks with no host attached is the warm-up or one being
	 *  retired, and nothing reads it again. Its question goes unanswered, since a
	 *  rejection would surface in the run's output as a fault of the capture. */
	private async bind(): Promise<void> {
		await this.page.exposeFunction(
			"__trunkInvoke",
			(cmd: string, args: Record<string, unknown>) =>
				this.host === null ? unanswered() : this.host.invoke(cmd, args),
		);
		await this.page.exposeFunction("__trunkHome", () =>
			this.host === null ? unanswered() : this.host.home,
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

	/** Takes the page off the application before the host goes, so nothing the
	 *  last capture's document still writes can reach the next capture's host. */
	private async retireHost(): Promise<void> {
		const retired = this.host;
		this.host = null;

		try {
			await this.page.goto("about:blank");
		} finally {
			await retired?.shutdown();
		}
	}

	private async attachHost(): Promise<HostClient> {
		const host = await HostClient.spawn();
		host.onEvent((event, payload) => {
			if (this.host !== host) return;
			void this.page
				.evaluate(([e, p]) => window.__trunkDeliver(e, p), [
					event,
					payload,
				] as const)
				.catch((error: unknown) => {
					// Retiring the host navigates away from the document it was delivering to.
					if (this.host === host) throw error;
				});
		});
		this.host = host;
		return host;
	}

	private async untilRowsDrawn(host: HostClient): Promise<void> {
		try {
			await this.page
				.locator("[data-testid=commit-row]")
				.first()
				.waitFor({ timeout: ROWS_DRAWN_MS });
		} catch (error) {
			throw new Error(
				`no commit row drew within ${ROWS_DRAWN_MS} ms\n${host.describeOutstanding()}`,
				{ cause: error },
			);
		}
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

/** What a run has started, closed newest first. Every closer runs even when an
 *  earlier one fails, since whatever it skipped would outlive the run. */
class Opened {
	private readonly closers: (() => unknown)[] = [];

	add(close: () => unknown): void {
		this.closers.push(close);
	}

	async close(): Promise<void> {
		const failures: unknown[] = [];
		for (const close of this.closers.splice(0).reverse()) {
			try {
				await close();
			} catch (error) {
				failures.push(error);
			}
		}

		if (failures.length > 0)
			throw new AggregateError(failures, "the visual harness did not close");
	}
}

/**
 * The graph column of the commit list: as wide as its header cell, from the top
 * of the first commit row to the bottom of the last. Nothing outside it is
 * captured, so a change to another column, to the header, or to the chrome
 * around the list leaves every capture as it was. The line from each ref pill
 * to its dot is the exception, since it runs into the graph column.
 */
function graphColumn(): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const cell = document.querySelector(
		"[data-testid=column-header] > [data-column=graph]",
	);
	const list = document.querySelector(".virtual-list-viewport");
	const rows = document.querySelectorAll("[data-testid=commit-row]");
	if (cell === null || list === null || rows.length === 0)
		throw new Error("the commit list or its graph column is not on the page");
	if (list.scrollHeight > list.clientHeight)
		throw new Error(
			"the commit list scrolls, so its last rows would go uncaptured: raise VIEWPORT's height",
		);

	const column = cell.getBoundingClientRect();
	const first = rows[0].getBoundingClientRect();
	const last = rows[rows.length - 1].getBoundingClientRect();
	return {
		x: column.left,
		y: first.top,
		width: column.width,
		height: last.bottom - first.top,
	};
}

/** Playwright's own message for a missing browser installs every engine it
 *  ships. The suite needs WebKit alone, at the version this checkout pins. */
async function launchWebKit(): Promise<Browser> {
	if (!existsSync(webkit.executablePath()))
		throw new Error(
			"Playwright's WebKit is not installed. Install it once with: mise exec -- bunx playwright install webkit",
		);
	return webkit.launch();
}

function unanswered(): Promise<never> {
	return new Promise(() => {});
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

async function comparePixels([baseline, capture, tolerance]: readonly [
	string,
	string,
	number,
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
			Math.abs(before[i] - after[i]) > tolerance ||
			Math.abs(before[i + 1] - after[i + 1]) > tolerance ||
			Math.abs(before[i + 2] - after[i + 2]) > tolerance ||
			Math.abs(before[i + 3] - after[i + 3]) > tolerance;
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
	const app = await loadConfigFromFile(
		{ command: "serve", mode: "development" },
		join(ROOT, "vite.config.ts"),
	);
	if (app === null) throw new Error("vite.config.ts did not load");
	const plugins = app.config.plugins ?? [];
	const served = plugins.filter((plugin) => !named(plugin, UNIT_TEST_PLUGIN));
	if (served.length === plugins.length)
		throw new Error(
			`vite.config.ts no longer lists ${UNIT_TEST_PLUGIN}: serve its plugins unfiltered`,
		);

	const server = await createServer({
		...app.config,
		plugins: served,
		configFile: false,
		root: ROOT,
		cacheDir: join(ROOT, "node_modules/.vite-visual"),
		optimizeDeps: { entries: [PAGE.slice(1)] },
		logLevel: "error",
		server: {
			host: "127.0.0.1",
			port: 0,
			hmr: false,
			watch: null,
			headers: { "Cache-Control": "max-age=3600" },
			warmup: { clientFiles: [PAGE.slice(1)] },
		},
	});
	return server.listen();
}

function named(plugin: PluginOption, name: string): boolean {
	if (!plugin || Array.isArray(plugin) || plugin instanceof Promise)
		return false;
	return plugin.name === name;
}
