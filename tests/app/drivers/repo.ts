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
