import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { firstMatching, openContextMenu } from "./dom.js";

const RECENT_ENTRY = '[role="button"]';
const COMMIT_ROW = '[data-testid="commit-row"]';
const COMMIT_SUMMARY = '[data-testid="commit-row-summary"]';
const COMMIT_SHA = '[title="Copy SHA"]';
// The label lives in a `span` inside this `foreignObject`, and a selector that
// names the span matches nothing: jsdom does not reach across the SVG boundary
// into its HTML children.
const REF_PILL = "g.overlay-pills foreignObject";
const OVERFLOW_BADGE = /^\+\d+$/;
const FILE_ROW = '[data-testid="staging-file"]';
const GRAPH_VIEWPORT = ".virtual-list-viewport";
const GRAPH_CONTENT = ".virtual-list-content";
const GRAPH_ROW = "[data-original-index]";

/**
 * The repository surface, in gestures rather than transport. The harness seeds
 * the repository into the application's recent list, so opening it is the click
 * a user makes on the welcome screen rather than a hand-wired `open_repo`.
 */
export class RepoDriver {
	constructor(
		readonly path: string,
		private readonly menu: FakeMenu,
	) {}

	async open(path: string = this.path): Promise<void> {
		const entry = await waitFor(`the recent entry for ${path}`, () =>
			recentEntry(path),
		);

		entry.click();

		await waitFor("the repository's commits", () =>
			this.rows().length > 0 ? true : null,
		);
	}

	/**
	 * Closes the repository the way the user does: the tab's close control, which is what
	 * calls `close_repo` and drops the backend's per-repo state.
	 */
	async close(): Promise<void> {
		const close = await waitFor("the tab's close control", () =>
			document.querySelector<HTMLButtonElement>('[aria-label="Close tab"]'),
		);
		close.click();

		await waitFor("the repository's commits to go", () =>
			this.rows().length === 0 ? true : null,
		);
	}

	/** Selects a commit, returning once the detail pane is listing its files. */
	async selectCommit(summary: string): Promise<void> {
		const row = await waitFor(`the ${summary} row`, () => commitRow(summary));

		row.click();

		await waitFor(`the files ${summary} touched`, () =>
			document.querySelector<HTMLElement>(FILE_ROW) ? true : null,
		);
	}

	/** Opens the selected commit's diff of one file in the center pane. */
	async openCommitFile(path: string): Promise<void> {
		const row = await waitFor(`the ${path} row`, () =>
			firstMatching(FILE_ROW, (text) => text.includes(path)),
		);

		row.click();
	}

	/**
	 * The files the selected commit's detail pane is listing, topmost first,
	 * each as its badge letter and path. Runs of layout whitespace collapse to
	 * one space, so a row reads as a user sees it however its markup nests.
	 */
	commitFiles(): string[] {
		const rows = document.querySelectorAll<HTMLElement>(FILE_ROW);

		return [...rows].map((row) =>
			(row.textContent ?? "").replace(/\s+/g, " ").trim(),
		);
	}

	/** Right-clicks a commit, returning once the menu it opens is on screen. */
	async contextMenu(summary: string): Promise<void> {
		const row = await waitFor(`the ${summary} row`, () => commitRow(summary));

		await openContextMenu(row, this.menu, summary);
	}

	/** Right-clicks a file in the selected commit's detail pane. */
	async commitFileContextMenu(path: string): Promise<void> {
		const row = await waitFor(`the ${path} row`, () =>
			firstMatching(FILE_ROW, (text) => text.includes(path)),
		);

		await openContextMenu(row, this.menu, path);
	}

	/** Every commit summary the graph is showing, top row first. */
	commitRows(): string[] {
		return this.rows().map((row) => row.textContent?.trim() ?? "");
	}

	/** The short hash the graph shows for each commit, top row first. */
	commitShas(): string[] {
		const shas = document.querySelectorAll<HTMLElement>(
			`${COMMIT_ROW} ${COMMIT_SHA}`,
		);

		return [...shas].map((sha) => sha.textContent?.trim() ?? "");
	}

	/**
	 * The ref label on each row the graph gives a pill, top row first. A row
	 * carrying several refs shows only the highest-priority one and folds the
	 * rest into a `+N` badge, which is not a label and is dropped here.
	 */
	refPills(): string[] {
		const labels = document.querySelectorAll<SVGElement>(REF_PILL);

		return [...labels]
			.map((label) => label.textContent?.trim() ?? "")
			.filter((label) => !OVERFLOW_BADGE.test(label));
	}

	/** A working-tree file as it stands on disk, which is where a discard lands
	 *  and what the diff pane is a re-read of. */
	workingTreeFile(relativePath: string): string {
		return readFileSync(join(this.path, relativePath), "utf8");
	}

	/** Writes a working-tree file, the edit a user makes in their own editor.
	 *  Nothing refreshes on it — the watcher is off — so the panel reads the
	 *  content at the next gesture that reloads status. */
	writeWorkingTreeFile(relativePath: string, content: string): void {
		writeFileSync(join(this.path, relativePath), content);
	}

	/**
	 * Scrolls the graph to the end of the rows it has loaded and returns once the
	 * list is rendering them, which is the gesture that asks for the next page.
	 *
	 * Each attempt moves away from the tail first, so the assignment is a change
	 * the list can notice. Re-issuing a position it already holds produces no
	 * scroll it acts on.
	 */
	async scrollToTail(): Promise<void> {
		const viewport = await waitFor("the graph's scroll viewport", () =>
			document.querySelector<HTMLElement>(GRAPH_VIEWPORT),
		);

		// The list acts on a scroll a frame later, ignores one that moves less than
		// half a row, and right after mount is still settling its own scroll to
		// HEAD, which swallows the first gesture whole. So keep asking until the
		// window holds the deepest loaded row.
		//
		// That reading says the viewport arrived, not that a page followed, so a
		// stalled pager satisfies it and fails on the caller's assertion rather
		// than on this wait.
		await waitFor("the graph to render its deepest loaded row", () => {
			if (this.renderedEnd() >= this.loadedDepth()) return true;

			this.scrollTo(viewport, 0);
			this.scrollTo(viewport, this.contentHeight());

			return null;
		});
	}

	/**
	 * How many commit rows the graph has paged in, which is what paging deeper
	 * grows.
	 *
	 * Read from the scroll range the list sized itself to, divided by the height
	 * of a row. Neither the rendered rows nor their `data-original-index` can
	 * answer it: both describe the virtual list's window over the loaded rows,
	 * which stays small however deep the list goes, so a stalled pager and a
	 * working one look identical through them.
	 */
	loadedDepth(): number {
		const row = document.querySelector<HTMLElement>(GRAPH_ROW);
		const rowHeight = row?.getBoundingClientRect().height ?? 0;
		if (rowHeight <= 0) return 0;

		return Math.round(this.contentHeight() / rowHeight);
	}

	private scrollTo(viewport: HTMLElement, top: number): void {
		viewport.scrollTop = top;
		viewport.dispatchEvent(new Event("scroll"));
	}

	/** How far down the loaded rows the list's window currently reaches, as a
	 *  count of rows. */
	private renderedEnd(): number {
		const rows = document.querySelectorAll<HTMLElement>(GRAPH_ROW);

		let deepest = -1;
		for (const row of rows) {
			const index = Number.parseInt(row.dataset.originalIndex ?? "", 10);
			if (Number.isFinite(index) && index > deepest) deepest = index;
		}

		return deepest + 1;
	}

	/** How tall the list has made its content, which is the scroll range. jsdom
	 *  reports 0 for `scrollHeight`, so the list's own inline height is the only
	 *  reading of it available here. */
	private contentHeight(): number {
		const content = document.querySelector<HTMLElement>(GRAPH_CONTENT);
		const declared = Number.parseFloat(content?.style.height ?? "");

		return Number.isFinite(declared) ? declared : 0;
	}

	/** The short hash the graph shows for one commit. */
	shaOf(summary: string): string {
		const at = this.commitRows().indexOf(summary);
		if (at === -1) throw new Error(`the graph is not showing ${summary}`);

		return this.commitShas()[at];
	}

	private rows(): HTMLElement[] {
		return [...document.querySelectorAll<HTMLElement>(COMMIT_SUMMARY)];
	}
}

function recentEntry(path: string): HTMLElement | null {
	return firstMatching(RECENT_ENTRY, (text) => text.includes(path));
}

function commitRow(summary: string): HTMLElement | null {
	const cell = firstMatching(COMMIT_SUMMARY, (text) => text === summary);

	return cell?.closest<HTMLElement>(COMMIT_ROW) ?? null;
}
