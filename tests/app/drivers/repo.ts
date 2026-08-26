import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const RECENT_ENTRY = '[role="button"]';
const COMMIT_ROW = '[data-testid="commit-row"]';
const COMMIT_SUMMARY = '[data-testid="commit-row-summary"]';

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

	/** Right-clicks a commit, returning once the menu it opens is on screen. */
	async contextMenu(summary: string): Promise<void> {
		const row = await waitFor(`the ${summary} row`, () => commitRow(summary));

		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

		await waitFor(`the context menu on ${summary}`, () =>
			this.menu.items().length > 0 ? true : null,
		);
	}

	/** Every commit summary the graph is showing, top row first. */
	commitRows(): string[] {
		return this.rows().map((row) => row.textContent?.trim() ?? "");
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
