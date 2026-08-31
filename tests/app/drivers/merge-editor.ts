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
}
