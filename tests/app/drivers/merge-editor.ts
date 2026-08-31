import { waitFor } from "../harness/wait.js";
import { enabledButton } from "./dom.js";

/** The three-panel conflict editor a conflicted file's row opens onto. */
export class MergeEditorDriver {
	/** Takes the incoming side of every conflict. */
	async takeAllIncoming(): Promise<void> {
		await press("Take All Incoming");
	}

	/** Takes the current side of every conflict. */
	async takeAllCurrent(): Promise<void> {
		await press("Take All Current");
	}

	/** Saves the assembled result and marks the file resolved. */
	async saveAndResolve(): Promise<void> {
		await press("Save and Mark Resolved");
	}
}

async function press(label: string): Promise<void> {
	const button = await waitFor(`an enabled ${label} button`, () =>
		enabledButton(label),
	);

	button.click();
}
