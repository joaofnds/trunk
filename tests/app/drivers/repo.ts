import { waitFor } from "../harness/wait.js";

const RECENT_ENTRY = '[role="button"]';
const COMMIT_SUMMARY = '[data-testid="commit-row-summary"]';

/**
 * The repository surface, in gestures rather than transport. The harness seeds
 * the repository into the application's recent list, so opening it is the click
 * a user makes on the welcome screen rather than a hand-wired `open_repo`.
 */
export class RepoDriver {
	constructor(readonly path: string) {}

	async open(path: string = this.path): Promise<void> {
		const entry = await waitFor(`the recent entry for ${path}`, () =>
			recentEntry(path),
		);

		entry.click();

		await waitFor("the repository's commits", () =>
			this.rows().length > 0 ? true : null,
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
	const entries = document.querySelectorAll<HTMLElement>(RECENT_ENTRY);
	for (const entry of entries) {
		if (entry.textContent?.includes(path)) return entry;
	}
	return null;
}
