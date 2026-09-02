import { pressButton } from "./dom.js";

/** The three-panel conflict editor a conflicted file's row opens onto. */
export class MergeEditorDriver {
	/** Takes the incoming side of every conflict. */
	async takeAllIncoming(): Promise<void> {
		await pressButton("Take All Incoming");
	}

	/** Takes the current side of every conflict. */
	async takeAllCurrent(): Promise<void> {
		await pressButton("Take All Current");
	}

	/** Saves the assembled result and marks the file resolved. */
	async saveAndResolve(): Promise<void> {
		await pressButton("Save and Mark Resolved");
	}

	/** Whether the editor is on screen, judged by the controls only it offers.
	 *  It describes one conflict, so it has no business outliving the operation
	 *  that raised it. */
	isShowing(): boolean {
		return [...document.querySelectorAll("button")].some(
			(button) => button.textContent?.trim() === "Save and Mark Resolved",
		);
	}
}
