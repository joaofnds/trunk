import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type Browser,
	type Locator,
	type Page,
	type Route,
	webkit,
} from "playwright";
import { inject, type TestContext } from "vitest";
import type { Thread } from "../../src/lib/types.js";
import { HostClient, type RepoSpec } from "../app/harness/host-client.js";
import type { Difference } from "./baseline.js";
import "./page/bindings.js";
import { CATALOG_PAGE, PAGE, ROOT } from "./server.js";

const DEFAULT_FIXTURES = "src-tauri/target/debug/fixtures";

/** The cases whose repositories carry a commit graph worth a baseline. */
const GRAPH_CASES = [
	"graph-lanes",
	"graph-merges",
	"kitchen-sink",
	"stash-lanes",
];

/** The window every capture is taken in, tall enough to hold the longest graph
 *  without scrolling, and the day its relative dates count from. */
const VIEWPORT = { width: 1200, height: 1800 };
const NOW = new Date("2026-09-01T00:00:00Z");

/** How many levels of 255 a pixel's channel may move before the pixel differs.
 *  GitHub's macOS runner draws a diagonal rail up to 12 levels away from this
 *  Mac, and an erased rail moves at least 96 pixels per capture by more than 64. */
const CHANNEL_TOLERANCE = 24;

/** Glyphs differ between machines by more than the tolerance, and the advance
 *  widths that size a footer's buttons do not, so a footer's text draws clear. */
const CLEAR_TEXT =
	"* { color: transparent !important; caret-color: transparent !important; } ::placeholder { color: transparent !important; }";

/** Captures that differ this many times running mean the page never settled. */
const SETTLE_ATTEMPTS = 5;

/** The repository each page captures before the tests. It draws every kind of
 *  row the others do, so its capture runs whatever their first one would. */
const WARM_UP_REPOSITORY = "kitchen-sink";

/** The warm-up is no test, so nothing abandons its captures, and each of their
 *  waits ends at Playwright's own timeout. */
const NEVER_ABANDONED = new AbortController().signal;

/** Pages capturing at once. Each capture mostly waits on its host and its page,
 *  so a few overlap well. vitest runs at most five tests at once, so a sixth
 *  page would never be borrowed (docs/visual-regression.md). */
const PAGES = pageCount(process.env.TRUNK_VISUAL_PAGES ?? "5");

const GRAPH_SHAPE: HarnessShape = { cases: GRAPH_CASES, pages: PAGES };

/** The test a capture is taken for: the signal vitest aborts when it abandons
 *  the test, and the note that then reaches the test's failure. */
export type CaptureTest = Pick<TestContext, "signal" | "annotate">;

export interface GraphView {
	/** Sizes the graph column as a user dragging it would, in CSS pixels. */
	graphColumnWidth?: number;
	/** Pans the graph column sideways by this many CSS pixels, as a sideways
	 *  swipe over it would. */
	pan?: number;
}

/** The fixture cases a harness builds and the pages it captures on at once. */
export interface HarnessShape {
	cases: readonly string[];
	pages: number;
	/** The suite's captures run the user's git, so setup runs it once first. */
	runsUsersGit?: boolean;
}

/** A footer of the staging panel, in a repository stopped mid-operation. */
export interface FooterView {
	/** The footer's `data-testid`. */
	footer: string;
	/** Sizes the detail pane as a user dragging it would, in CSS pixels. */
	detailPaneWidth: number;
	/** Rebases the repository onto this branch through the app's own command
	 *  once it is open, for a repository the fixtures build unstopped. */
	rebaseOnto?: string;
}

interface ThreadTail {
	latestReply: boolean;
	composer: boolean;
	scrollable: boolean;
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

	/** A setup `stopped` before it finished closes what it had opened and
	 *  rejects. */
	static async setup(
		shape: HarnessShape,
		stopped: AbortSignal,
	): Promise<VisualHarness> {
		const opened = new Opened();
		try {
			return await VisualHarness.start(opened, shape, stopped);
		} catch (error) {
			return closeAfterFailure(opened, error);
		}
	}

	/** The fixture build takes longest, so the pages open and load the app beside it. */
	private static async start(
		opened: Opened,
		shape: HarnessShape,
		stopped: AbortSignal,
	): Promise<VisualHarness> {
		const repos = mkdtempSync(join(tmpdir(), "trunk-visual-"));
		opened.add(() => rmSync(repos, { recursive: true, force: true }));

		const [fixtures, browsing] = await Promise.allSettled([
			buildFixtures(repos, shape.cases, stopped),
			VisualHarness.openPages(opened, shape.pages, stopped),
			shape.runsUsersGit ? runUsersGitOnce(stopped) : undefined,
		]);
		stopped.throwIfAborted();
		if (fixtures.status === "rejected") throw fixtures.reason;
		if (browsing.status === "rejected") throw browsing.reason;

		const { browser, pages } = browsing.value;
		return new VisualHarness(repos, browser, pages, opened);
	}

	private static async openPages(
		opened: Opened,
		count: number,
		stopped: AbortSignal,
	): Promise<{ browser: Browser; pages: AppPage[] }> {
		const { browser, origin } = await openBrowser(opened);
		stopped.throwIfAborted();

		// A page that opened before another failed closes with the browser.
		const url = new URL(PAGE, origin).href;
		const pages = await Promise.all(
			Array.from({ length: count }, () => AppPage.open(browser, url)),
		);
		for (const page of pages) opened.add(() => page.close());

		return { browser, pages };
	}

	/** Each page takes its first capture here, and the tests take only later
	 *  ones, which cost less (docs/visual-regression.md). A capture that fails here
	 *  is taken again by its repository's own test, which reports the failure. */
	async warmUp(): Promise<void> {
		const repository = join(this.repos, WARM_UP_REPOSITORY);
		await Promise.allSettled(
			this.idle.map((page) =>
				page.captureGraph(repository, {}, NEVER_ABANDONED),
			),
		);
	}

	/** Every repository the graph cases built, as `case/repository`, or as the
	 *  case alone where the case is one repository. */
	graphRepositories(): string[] {
		return GRAPH_CASES.flatMap((graphCase) =>
			repositoriesIn(this.repos, graphCase),
		).sort();
	}

	/** Opens `repository` the way a restored tab does and captures the graph
	 *  column. */
	captureGraph(
		repository: string,
		test: CaptureTest,
		view: GraphView = {},
	): Promise<Buffer> {
		return this.onPage(test, (page) =>
			page.captureGraph(join(this.repos, repository), view, test.signal),
		);
	}

	inspectDiffCell(
		repository: string,
		test: CaptureTest,
	): Promise<{ cornersHit: boolean; label: string | null; selected: boolean }> {
		return this.onPage(test, (page) =>
			page.inspectDiffCell(join(this.repos, repository), test.signal),
		);
	}

	/** Opens `repository` the way a restored tab does and captures one footer
	 *  of the staging panel. */
	captureFooter(
		repository: string,
		test: CaptureTest,
		view: FooterView,
	): Promise<Buffer> {
		return this.onPage(test, (page) =>
			page.captureFooter(join(this.repos, repository), view, test.signal),
		);
	}

	readInlineReview(
		repo: RepoSpec,
		file: string,
		replies: readonly [string, ...string[]],
		test: CaptureTest,
		read: (review: InlineReviewDriver) => Promise<void>,
	): Promise<void> {
		return this.onPage(test, async (page) =>
			read(await page.openInlineReview(repo, file, replies, test.signal)),
		);
	}

	inspectMergeEditor<T>(
		repository: string,
		file: string,
		viewport: { width: number; height: number },
		test: CaptureTest,
		measure: (editor: Element) => T,
	): Promise<T> {
		return this.onPage(test, (page) =>
			page.inspectMergeEditor(
				join(this.repos, repository),
				file,
				viewport,
				test.signal,
				measure,
			),
		);
	}

	difference(baseline: Buffer, capture: Buffer): Promise<Difference> {
		return pixelDifference(this.browser, baseline, capture);
	}

	async teardown(): Promise<void> {
		await this.opened.close();
	}

	/** vitest drops whatever a test throws after its timeout. The note records
	 *  what the host still owed the page when vitest abandoned the test. */
	private async onPage<T>(
		test: CaptureTest,
		run: (page: AppPage) => Promise<T>,
	): Promise<T> {
		const page = await this.borrow();
		const report = () =>
			void test.annotate(
				`what the host owed the page when the test was abandoned:\n${page.describeHost()}`,
				"error",
			);
		test.signal.addEventListener("abort", report, { once: true });

		try {
			return await run(page);
		} finally {
			test.signal.removeEventListener("abort", report);
			this.giveBack(page);
		}
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
 * One suite's visual harness, from its start before the tests to its teardown
 * after them. vitest gives up on a hook at its timeout without telling the
 * hook, so the teardown stops a start still under way, whose fixture builds
 * would otherwise run on and leave their repositories behind.
 */
export class SuiteHarness {
	private readonly stopping = new AbortController();
	private started: Promise<VisualHarness | undefined> =
		Promise.resolve(undefined);

	/** The graph cases by default. A suite that captures fewer repositories
	 *  builds only the cases it reads and opens fewer pages. */
	start(shape: HarnessShape = GRAPH_SHAPE): Promise<VisualHarness> {
		const starting = VisualHarness.setup(shape, this.stopping.signal);
		this.started = starting.catch((error: unknown) => this.failedStart(error));

		return starting;
	}

	async teardown(): Promise<void> {
		this.stopping.abort();
		const harness = await this.started;
		await harness?.teardown();
	}

	/** Before the stop, a failed start fails the suite's beforeAll. After it,
	 *  vitest no longer awaits the start, so a failure other than the stop
	 *  itself, a repository left undeleted, fails the teardown instead. */
	private failedStart(error: unknown): undefined {
		const stop = this.stopping.signal;
		if (stop.aborted && error !== stop.reason) throw error;

		return undefined;
	}
}

/**
 * The design catalog (`src/lib/ui/Catalog.svelte`), served by Vite to one
 * WebKit page with no host behind it: the catalog mounts tokens and primitives
 * alone and asks the backend nothing.
 */
export class CatalogHarness {
	private constructor(
		private readonly browser: Browser,
		private readonly page: Page,
		private readonly url: string,
		private readonly opened: Opened,
	) {}

	static async setup(): Promise<CatalogHarness> {
		const opened = new Opened();
		try {
			const { browser, origin } = await openBrowser(opened);
			const page = await browser.newPage({
				viewport: VIEWPORT,
				deviceScaleFactor: 1,
			});
			opened.add(() => page.close());

			const url = new URL(CATALOG_PAGE, origin).href;
			return new CatalogHarness(browser, page, url, opened);
		} catch (error) {
			return closeAfterFailure(opened, error);
		}
	}

	/** The page takes its first capture here, and the test takes only a later
	 *  one, which costs less, as each graph page's does. A capture that fails
	 *  here is taken again by the test, which reports the failure. */
	async warmUp(): Promise<void> {
		await this.captureUntil(NEVER_ABANDONED).catch(() => undefined);
	}

	/** The whole catalog with every text label masked, since glyphs differ
	 *  between machines by more than the tolerance (docs/visual-regression.md)
	 *  and the tokens and primitives around them are what the baseline pins. */
	capture(test: CaptureTest): Promise<Buffer> {
		return this.captureUntil(test.signal);
	}

	private async captureUntil(abandoned: AbortSignal): Promise<Buffer> {
		await this.page.goto(this.url, { signal: abandoned });
		const catalog = this.page.locator("[data-testid=catalog]");
		await catalog.waitFor({ signal: abandoned });

		return settled(async () => {
			await painted(this.page);
			return catalog.screenshot({
				animations: "disabled",
				mask: [
					this.page.locator("[data-catalog-text], [data-catalog-headings] h3"),
				],
				signal: abandoned,
			});
		});
	}

	difference(baseline: Buffer, capture: Buffer): Promise<Difference> {
		return pixelDifference(this.browser, baseline, capture);
	}

	async teardown(): Promise<void> {
		await this.opened.close();
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

	async captureGraph(
		path: string,
		view: GraphView,
		abandoned: AbortSignal,
	): Promise<Buffer> {
		const prefs: Record<string, unknown> = {};
		if (view.graphColumnWidth !== undefined) {
			prefs[`column_user_widths:${path}`] = { graph: view.graphColumnWidth };
		}
		await this.openRepository(path, prefs, abandoned);

		// The stored column width arrives after the first rows draw. A wheel before
		// it is clamped to the fitted width's range, which is 0 for an uncapped fit.
		if (view.pan !== undefined) {
			await this.settledCapture(abandoned);
			await this.panGraph(view.pan);
		}

		return this.settledCapture(abandoned);
	}

	async inspectDiffCell(
		path: string,
		abandoned: AbortSignal,
	): Promise<{ cornersHit: boolean; label: string | null; selected: boolean }> {
		await this.openRepository(path, {}, abandoned);
		const row = this.page
			.getByTestId("commit-row")
			.filter({ hasText: "upstream five" });
		const cell = row.getByTestId("diff-stat");
		await cell.getByTestId("diff-stat-bar").waitFor({ signal: abandoned });
		const point = await cell.evaluate(
			(element) => {
				const header = element
					.closest('[role="listbox"]')
					?.querySelector("[data-testid=column-header] > [data-column=diff]");
				const row = element.closest('[role="option"]');
				if (!header || !row)
					throw new Error("diff column or commit row missing");
				const { left, right } = header.getBoundingClientRect();
				const { top, bottom } = row.getBoundingClientRect();
				const cornersHit = [left + 1, right - 1].every((x) =>
					[top + 1, bottom - 1].every((y) =>
						element.contains(document.elementFromPoint(x, y)),
					),
				);
				return { cornersHit, x: right - 1, y: bottom - 1 };
			},
			undefined,
			{ signal: abandoned },
		);
		await this.page.mouse.move(point.x, point.y);
		const label = await this.page
			.locator(".tooltip-pop-shown")
			.textContent({ signal: abandoned });
		await this.page.mouse.click(point.x, point.y);
		await row.and(this.page.locator('[aria-selected="true"]')).waitFor({
			signal: abandoned,
		});
		return {
			cornersHit: point.cornersHit,
			label,
			selected:
				(await row.getAttribute("aria-selected", { signal: abandoned })) ===
				"true",
		};
	}

	/** The footer is what the capture waits for: a rebase the command stops
	 *  draws it only once the graph it rebuilt reaches the page. */
	async captureFooter(
		path: string,
		view: FooterView,
		abandoned: AbortSignal,
	): Promise<Buffer> {
		await this.openRepository(
			path,
			{ right_pane_width: view.detailPaneWidth },
			abandoned,
		);
		if (view.rebaseOnto !== undefined) {
			await this.currentHost().invoke("rebase_branch", {
				path,
				ontoBranch: view.rebaseOnto,
			});
		}

		const footer = this.page.locator(`[data-testid=${view.footer}]`);
		await footer.waitFor({ signal: abandoned });
		return settled(async () => {
			await this.idle(abandoned);
			return footer.screenshot({
				animations: "disabled",
				style: CLEAR_TEXT,
				signal: abandoned,
			});
		});
	}

	async openInlineReview(
		repo: RepoSpec,
		file: string,
		replies: readonly [string, ...string[]],
		abandoned: AbortSignal,
	): Promise<InlineReviewDriver> {
		await this.page.setViewportSize({ width: VIEWPORT.width, height: 800 });
		const path = await this.openRepository(repo, {}, abandoned);
		const options = { signal: abandoned };
		await this.page
			.getByTestId("commit-row")
			.filter({ hasText: "// WIP" })
			.click(options);
		await this.page
			.getByTestId("staging-unstaged-section")
			.getByTitle(file, { exact: true })
			.click(options);
		await this.page.getByTitle("Side-by-side view").click(options);
		const viewport = this.page.locator(".split-view .exact-virtual-viewport");
		await viewport
			.getByRole("button", { name: "Comment", exact: true })
			.click(options);
		await viewport
			.getByRole("textbox", { name: "Comment", exact: true })
			.fill("Root comment", options);
		await viewport
			.getByRole("button", { name: "Add comment", exact: true })
			.click(options);
		await viewport.getByText("Root comment", { exact: true }).waitFor(options);

		const host = this.currentHost();
		const [thread] = await host.invoke<Pick<Thread, "id">[]>("list_threads", {
			path,
		});
		if (!thread) throw new Error("the submitted inline comment has no thread");

		for (const text of replies) {
			await host.invoke("add_reply", {
				path,
				threadId: thread.id,
				text,
				delivery: "send",
			});
		}

		return new InlineReviewDriver(
			this.page,
			this.page.locator(".exact-virtual-viewport"),
			abandoned,
		);
	}

	async inspectMergeEditor<T>(
		path: string,
		file: string,
		viewport: { width: number; height: number },
		abandoned: AbortSignal,
		measure: (editor: Element) => T,
	): Promise<T> {
		const options = { signal: abandoned };
		try {
			await this.openRepository(path, {}, abandoned);
			await this.page
				.getByTestId("staging-file")
				.getByTitle(file, { exact: true })
				.click(options);
			const editor = this.page.getByRole("region", {
				name: "Merge editor",
				exact: true,
			});
			await editor
				.getByRole("textbox", { name: "Merge output" })
				.waitFor(options);
			await this.page.setViewportSize(viewport);
			await this.idle(abandoned);

			return await editor.evaluate(measure, undefined, options);
		} finally {
			await this.page.setViewportSize(VIEWPORT);
		}
	}

	describeHost(): string {
		if (this.host === null) return "no host attached";
		return this.host.describeOutstanding();
	}

	async close(): Promise<void> {
		const retired = this.host;
		this.host = null;
		await retired?.shutdown();

		await this.page.close();
	}

	/** A document that asks with no host attached is the one `open` loads to
	 *  cache the app's modules or one being retired, and nothing reads it again.
	 *  Its question goes unanswered, since a rejection would surface in the run's
	 *  output as a fault of the capture. */
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
	private async retireHost(abandoned: AbortSignal): Promise<void> {
		const retired = this.host;
		this.host = null;

		try {
			await this.page.goto("about:blank", { signal: abandoned });
		} finally {
			await retired?.shutdown();
		}
	}

	private async attachHost(): Promise<void> {
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
	}

	/** A sideways wheel over the graph column. The pointer then rests in the
	 *  window's corner, since the row under it draws a hover into the column. */
	private async panGraph(by: number): Promise<void> {
		const column = await this.page.evaluate(graphColumn);

		await this.page.mouse.move(
			column.x + column.width / 2,
			column.y + column.height / 2,
		);
		await this.page.mouse.wheel(by, 0);
		await this.page.mouse.move(0, 0);
	}

	/** A fresh host whose stored prefs restore `path` as the one open tab, with
	 *  `prefs` stored beside them, and the app loaded until its first row draws. */
	private async openRepository(
		repo: string | RepoSpec,
		prefs: Record<string, unknown>,
		abandoned: AbortSignal,
	): Promise<string> {
		await this.retireHost(abandoned);
		await this.attachHost();
		const path =
			typeof repo === "string" ? repo : await this.currentHost().seedRepo(repo);
		await this.storeTab(path, prefs);

		await this.page.goto(this.url, { signal: abandoned });
		await this.page
			.locator("[data-testid=commit-row]")
			.first()
			.waitFor({ signal: abandoned });
		return path;
	}

	private async storeTab(
		path: string,
		prefs: Record<string, unknown>,
	): Promise<void> {
		const host = this.currentHost();
		const name = basename(path);
		const stored: Record<string, unknown> = {
			open_tabs: [{ id: "visual", repoPath: path, repoName: name }],
			active_tab_id: "visual",
			recent_repos: [{ name, path }],
			...prefs,
		};

		for (const [key, value] of Object.entries(stored))
			await host.invoke("prefs_set", { key, value });
	}

	/**
	 * A capture taken once nothing is owed by the host and two frames have
	 * painted, repeated until two in a row are identical. A stored column width
	 * arrives by a round trip after the first rails draw, so the first capture
	 * can precede it, which is also why the column is measured on every attempt.
	 */
	private settledCapture(abandoned: AbortSignal): Promise<Buffer> {
		return settled(async () => {
			await this.idle(abandoned);
			return this.page.screenshot({
				clip: await this.page.evaluate(graphColumn),
				animations: "disabled",
				signal: abandoned,
			});
		});
	}

	/** Nothing is owed by the host and two frames have painted. */
	private async idle(abandoned: AbortSignal): Promise<void> {
		await this.page.waitForFunction(() => window.__trunkPending === 0, null, {
			signal: abandoned,
		});
		await painted(this.page);
	}

	private currentHost(): HostClient {
		if (this.host === null)
			throw new Error("no host: capture a repository first");
		return this.host;
	}
}

class InlineReviewDriver {
	constructor(
		private readonly page: Page,
		private readonly viewport: Locator,
		private readonly signal: AbortSignal,
	) {}

	private get showEarlier(): Locator {
		return this.viewport.getByRole("button", {
			name: /^Show \d+ (?:more|earlier) replies$/,
		});
	}

	async expandEarlierReplies(firstReplyLine: string): Promise<void> {
		await this.showEarlier.click({ signal: this.signal });
		await this.viewport
			.getByText(firstReplyLine, { exact: true })
			.waitFor({ signal: this.signal });
		await painted(this.page);
	}

	async collapseEarlierRepliesFromKeyboard(): Promise<void> {
		await this.page.keyboard.press("Enter");
		await this.showEarlier.waitFor({ signal: this.signal });
	}

	earlierRepliesToggleHasFocus(): Promise<boolean> {
		return this.showEarlier.evaluate(
			(button) => button === document.activeElement,
		);
	}

	async readFromParagraph(text: string, offset: number): Promise<void> {
		await this.viewport
			.getByText(text, { exact: true })
			.evaluate((paragraph, y) => {
				const viewport = paragraph.closest<HTMLElement>(
					".exact-virtual-viewport",
				);
				if (!viewport)
					throw new Error("the paragraph is outside the diff viewport");

				viewport.scrollTop +=
					paragraph.getBoundingClientRect().top -
					viewport.getBoundingClientRect().top -
					y;
			}, offset);
		await painted(this.page);
	}

	async delayIllustration(url: string): Promise<() => Promise<void>> {
		const request = Promise.withResolvers<Route>();
		await this.page.route(url, (route) => request.resolve(route));

		return async () => {
			const route = await request.promise;
			await route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160"/>',
			});
			await this.page.waitForFunction(
				(src) =>
					Array.from(document.images).some(
						(image) => image.src === src && image.naturalHeight > 0,
					),
				url,
				{ signal: this.signal },
			);
			await painted(this.page);
			await this.page.unroute(url);
		};
	}

	paragraphPosition(text: string) {
		return this.viewport
			.getByText(text, { exact: true })
			.evaluate((paragraph) => {
				const viewport = paragraph.closest(".exact-virtual-viewport");
				if (!viewport)
					throw new Error("the paragraph is outside the diff viewport");

				return {
					offset:
						paragraph.getBoundingClientRect().top -
						viewport.getBoundingClientRect().top,
					scrollTop: viewport.scrollTop,
					scrollLimit: viewport.scrollHeight - viewport.clientHeight,
				};
			});
	}

	async switchToUnified(): Promise<void> {
		const options = { signal: this.signal };
		await this.page.getByTitle("Inline view").click(options);
		await this.page
			.locator(".hunk-view .exact-virtual-viewport")
			.waitFor(options);
		await painted(this.page);
	}

	async scrollToEnd(): Promise<void> {
		await this.viewport.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await painted(this.page);
	}

	async backToRecentReplies(): Promise<void> {
		await this.viewport
			.getByRole("button", { name: "Back to recent replies", exact: true })
			.click({ signal: this.signal });
		await this.showEarlier.waitFor({ signal: this.signal });
		await painted(this.page);
	}

	async replyTexts(): Promise<string[]> {
		const texts = await this.viewport
			.locator(".thread-reply-text")
			.allTextContents();
		return texts.map((text) => text.trim());
	}

	focusedReply(): Promise<string | null> {
		return this.viewport
			.locator("[data-thread-entry]:focus [data-thread-reply-body]")
			.evaluateAll((elements) => elements[0]?.textContent?.trim() ?? null);
	}

	tail(latest: string): Promise<ThreadTail> {
		return this.viewport.evaluate((element, replyText) => {
			const bounds = element
				.querySelector(".exact-virtual-surface")
				?.getBoundingClientRect();
			const viewportBounds = element.getBoundingClientRect();
			const reply = [...element.querySelectorAll(".thread-reply-text")].find(
				(message) => message.textContent?.trim() === replyText,
			);
			const composer = element.querySelector('textarea[aria-label="Reply"]');

			function reachable(target: Element | null | undefined): boolean {
				if (!target || !bounds) return false;

				const box = target.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				);
				return (
					box.top >= Math.max(bounds.top, viewportBounds.top) &&
					box.bottom <= Math.min(bounds.bottom, viewportBounds.bottom) &&
					box.left >= Math.max(bounds.left, viewportBounds.left) &&
					box.right <= Math.min(bounds.right, viewportBounds.right) &&
					target.contains(hit)
				);
			}

			return {
				latestReply: reachable(reply),
				composer: reachable(composer),
				scrollable: element.scrollHeight > element.clientHeight,
			};
		}, latest);
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

/** The bare remotes some cases push to sit in a dot directory and are no
 *  graph, and a case's notes sit beside its repositories as files. */
function repositoriesIn(repos: string, graphCase: string): string[] {
	const dir = join(repos, graphCase);
	if (existsSync(join(dir, ".git"))) return [graphCase];

	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => `${graphCase}/${entry.name}`);
}

/** `capture` taken again until two in a row are identical. */
async function settled(capture: () => Promise<Buffer>): Promise<Buffer> {
	let previous: Buffer | null = null;

	for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
		const current = await capture();
		if (previous?.equals(current)) return current;
		previous = current;
	}

	throw new Error(
		`the page kept changing across ${SETTLE_ATTEMPTS} captures; it never settled`,
	);
}

/** Resolves once two frames have painted, so what the page last applied is on screen. */
function painted(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((frame) =>
				requestAnimationFrame(() => requestAnimationFrame(() => frame())),
			),
	);
}

/** Decodes both images in the browser and counts the pixels with a channel
 *  more than `CHANNEL_TOLERANCE` levels from the baseline's. */
async function pixelDifference(
	browser: Browser,
	baseline: Buffer,
	capture: Buffer,
): Promise<Difference> {
	const page = await browser.newPage();
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

/** WebKit, closed with the run, and the run's page server (global-setup.ts). */
async function openBrowser(
	opened: Opened,
): Promise<{ browser: Browser; origin: string }> {
	const browser = await launchWebKit();
	opened.add(() => browser.close());

	return { browser, origin: inject("pageOrigin") };
}

/** Closes what a failed setup had opened, and reports both faults when that fails too. */
async function closeAfterFailure(
	opened: Opened,
	error: unknown,
): Promise<never> {
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

/** Every build's process exits before this returns. When one fails or the
 *  builds are stopped, their directory is deleted then, without waiting for
 *  the pages, so a teardown that vitest also gives up on leaves none behind. */
async function buildFixtures(
	out: string,
	cases: readonly string[],
	stopped: AbortSignal,
): Promise<void> {
	const binary = process.env.TRUNK_FIXTURES ?? join(ROOT, DEFAULT_FIXTURES);
	const builds = await Promise.allSettled(
		cases.map((fixtureCase) =>
			buildCase(binary, ["build", fixtureCase, "--out", out], stopped),
		),
	);
	const failures = builds
		.filter((build) => build.status === "rejected")
		.map((build) => build.reason);
	if (!stopped.aborted && failures.length === 0) return;

	rmSync(out, { recursive: true, force: true });
	stopped.throwIfAborted();
	throw new AggregateError(failures, "the fixture cases did not all build");
}

/** Settles once the build's process has exited, a stopped one too, so
 *  nothing writes into the directory after the run deletes it. */
function buildCase(
	binary: string,
	args: readonly string[],
	stopped: AbortSignal,
): Promise<void> {
	return new Promise((built, failed) => {
		const build = spawn(binary, args, {
			signal: stopped,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let output = "";
		build.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		build.on("error", (error) => {
			output += error.message;
		});

		build.on("close", (code, signal) => {
			if (code === 0) return built();

			const ending = signal ?? `exit code ${code}`;
			failed(
				new Error(
					`${[binary, ...args].join(" ")} ended with ${ending}:\n${output}`,
				),
			);
		});
	});
}

/**
 * Runs the git the host will run, once. Apple's /usr/bin/git finds the real
 * binary through `xcodebuild -find git`, which on a fresh CI runner took 16 s
 * of a 20 s capture the first time (run 44649181007, TRUNK-500), and setup
 * has the time a capture does not. With SHELL empty the host takes its PATH
 * from path_helper, as `shell_env::system_path` does, so this does too. It
 * settles once git has exited, and a failure is left to the capture, which
 * reports git's own error.
 */
function runUsersGitOnce(stopped: AbortSignal): Promise<void> {
	if (process.platform !== "darwin") return Promise.resolve();

	return new Promise((ran) => {
		execFile(
			"/usr/libexec/path_helper",
			["-s"],
			{ signal: stopped },
			(helperFailed, stdout) => {
				const path = /PATH="([^"]*)"/.exec(stdout)?.[1];
				if (helperFailed || path === undefined) return ran();

				const env = { ...process.env, PATH: path };
				execFile("git", ["--version"], { signal: stopped, env }, () => ran());
			},
		);
	});
}
