import { waitFor } from "../harness/wait.js";

const EDITOR = ".rebase-editor";
const ROW = "[data-rebase-row]";
const MESSAGE = ".rebase-cell-message";
const TOOLBAR = ".rebase-toolbar-meta";
const START = ".rebase-btn-start";

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
