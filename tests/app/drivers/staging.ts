import { waitFor } from "../harness/wait.js";

const COMMIT_ROW = '[data-testid="commit-row"]';
const STAGE_ALL = '[aria-label="Stage all changes"]';
const SUBJECT = '[data-testid="commit-form-subject"]';
const SUBMIT = '[data-testid="commit-form-submit"]';
const WIP_OID_TEXT = "// WIP";

/** The working-tree view: what the graph's top row opens onto, and the commit
 *  the user builds there. */
export class StagingDriver {
	async open(): Promise<void> {
		const row = await waitFor("the working-tree row", workingTreeRow);

		row.click();
	}

	/**
	 * Returns once nothing is left unstaged. The button clears itself when the
	 * unstaged section empties, and waiting for that is the difference between a
	 * commit that carries the change and one that races the staging call.
	 */
	async stageEverything(): Promise<void> {
		const button = await waitFor("the stage-all button", stageAllButton);

		button.click();

		await waitFor("an empty unstaged section", () =>
			stageAllButton() ? null : true,
		);
	}

	async commit(subject: string): Promise<void> {
		const field = await waitFor("the commit subject field", () =>
			document.querySelector<HTMLInputElement>(SUBJECT),
		);
		field.value = subject;
		field.dispatchEvent(new Event("input", { bubbles: true }));

		const submit = await waitFor("an enabled commit button", () => {
			const button = document.querySelector<HTMLButtonElement>(SUBMIT);
			return button && !button.disabled ? button : null;
		});
		submit.click();
	}
}

function stageAllButton(): HTMLElement | null {
	return document.querySelector<HTMLElement>(STAGE_ALL);
}

function workingTreeRow(): HTMLElement | null {
	const rows = document.querySelectorAll<HTMLElement>(COMMIT_ROW);
	for (const row of rows) {
		if (row.textContent?.includes(WIP_OID_TEXT)) return row;
	}
	return null;
}
