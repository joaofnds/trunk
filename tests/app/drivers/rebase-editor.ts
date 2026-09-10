import { waitFor } from "../harness/wait.js";

const EDITOR = ".rebase-editor";
const ROW = "[data-rebase-row]";
const MESSAGE = ".rebase-cell-message";
const TOOLBAR = ".rebase-toolbar-meta";
const START = ".rebase-btn-start";
const CANCEL = ".rebase-btn-cancel";
const FILE_ROW = '[data-testid="staging-file"]';
const DETAIL_SUMMARY = ".commit-message .summary";
const DIFF_PATH = '[data-testid="diff-path"]';
const CLOSE_DIFF = '[aria-label="Close diff"]';

/** The interactive-rebase plan, in the gestures the editor offers: rows read
 *  newest first, the way the graph shows them. */
export class RebaseEditorDriver {
	/** Every commit summary the plan lists, newest first. */
	async rows(): Promise<string[]> {
		const rows = await this.openRows();

		return rows.map((row) => textOf(row.querySelector(MESSAGE)));
	}

	/** What the toolbar says this rebase is about to do. */
	async toolbarLabel(): Promise<string> {
		await this.openRows();

		return textOf(document.querySelector(TOOLBAR));
	}

	/**
	 * Moves a row by the keyboard gesture the editor offers. Reordering by drag
	 * is SortableJS, whose `onEnd` a test cannot reach; Shift+Arrow swaps the
	 * same adjacent rows through the DOM, so the reorder under test is the one a
	 * user performs.
	 */
	async move(from: number, to: number): Promise<void> {
		const rows = await this.openRows();
		rows[from].click();

		const key = to < from ? "ArrowUp" : "ArrowDown";
		for (let step = 0; step < Math.abs(to - from); step++) {
			this.press(key);
		}
	}

	async setAction(row: number, action: string): Promise<void> {
		const rows = await this.openRows();
		const select = rows[row].querySelector<HTMLSelectElement>("select");
		if (!select) throw new Error(`row ${row} offers no action to set`);

		select.value = action;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	}

	/** Focuses the commit whose detail and files the rebase takeover owns. */
	async focus(summary: string): Promise<void> {
		const rows = await this.openRows();
		const row = rows.find(
			(candidate) => textOf(candidate.querySelector(MESSAGE)) === summary,
		);
		if (!row) throw new Error(`the rebase plan has no ${summary} row`);

		row.click();
		await waitFor(`the ${summary} rebase detail`, () =>
			textOf(document.querySelector(DETAIL_SUMMARY)) === summary ? true : null,
		);
	}

	/** Opens one file from the focused commit in the rebase takeover's diff. */
	async openFile(path: string): Promise<void> {
		const row = await waitFor(
			`the ${path} rebase file`,
			() =>
				[...document.querySelectorAll<HTMLElement>(FILE_ROW)].find(
					(candidate) => textOf(candidate).includes(path),
				) ?? null,
		);

		row.click();
		await waitFor(`the ${path} rebase diff`, () =>
			textOf(document.querySelector(DIFF_PATH)) === path ? true : null,
		);
	}

	/** Leaves the focused diff while keeping the interactive-rebase takeover. */
	async closeDiff(): Promise<void> {
		const close = await waitFor("the rebase diff close control", () =>
			document.querySelector<HTMLButtonElement>(CLOSE_DIFF),
		);

		close.click();
		await waitFor("the rebase diff to close", () =>
			document.querySelector(CLOSE_DIFF) === null ? true : null,
		);
	}

	/** Closes the takeover without starting its plan. */
	async cancel(): Promise<void> {
		const cancel = await waitFor("the cancel-rebase button", () =>
			document.querySelector<HTMLButtonElement>(CANCEL),
		);

		cancel.click();
		await waitFor("the rebase editor to close", () =>
			document.querySelector(EDITOR) === null ? true : null,
		);
	}

	async start(): Promise<void> {
		await this.openRows();
		const button = await waitFor("an enabled start button", () => {
			const button = document.querySelector<HTMLButtonElement>(START);
			return button && !button.disabled ? button : null;
		});

		button.click();
	}

	private async openRows(): Promise<HTMLElement[]> {
		return await waitFor("the rebase editor's rows", () => {
			const rows = [...document.querySelectorAll<HTMLElement>(ROW)];
			return rows.length > 0 ? rows : null;
		});
	}

	private press(key: string): void {
		const editor = document.querySelector(EDITOR);
		editor?.dispatchEvent(
			new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }),
		);
	}
}

function textOf(element: Element | null): string {
	return element?.textContent?.trim().replace(/\s+/g, " ") ?? "";
}
