import { waitFor } from "../harness/wait.js";

/** The toolbar's history pair. Each gesture waits out the button's own gate:
 *  Undo is disabled until the head commit has exactly one parent, Redo until an
 *  undo has handed it something to restore. */
export class ToolbarDriver {
	async undo(): Promise<void> {
		await press("Undo");
	}

	async redo(): Promise<void> {
		await press("Redo");
	}

	/** Whether Redo is on offer right now. A redo restores the undone commit
	 *  where the undo left HEAD, so once HEAD moves elsewhere the offer has to
	 *  be withdrawn rather than replayed against the new position. */
	offersRedo(): boolean {
		const found = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Redo"]',
		);
		return found !== null && !found.disabled;
	}

	async stash(): Promise<void> {
		await press("Stash");
	}

	async pop(): Promise<void> {
		await press("Pop");
	}
}

async function press(label: string): Promise<void> {
	const button = await waitFor(`an enabled ${label} button`, () => {
		const found = document.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`,
		);
		return found && !found.disabled ? found : null;
	});

	button.click();
}
