import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const COMMIT_ROW = '[data-testid="commit-row"]';
const UNSTAGED_SECTION = '[data-testid="staging-unstaged-section"]';
const FILE_ROW = '[data-testid="staging-file"]';
const STAGED_SECTION = '[data-testid="staging-staged-section"]';
const HUNK_TOOLBAR = ".hunk-toolbar";
const HUNK_HEADER = `${HUNK_TOOLBAR} .hunk-header-text`;
const ADDED_LINE = ".diff-line-add .diff-line-content";
const STAGE_HUNK = "Stage Hunk";
const STAGE_ALL = '[aria-label="Stage all changes"]';
const SUBJECT = '[data-testid="commit-form-subject"]';
const SUBMIT = '[data-testid="commit-form-submit"]';
const WIP_PLACEHOLDER = "// WIP";
const REBASE_PROGRESS = "Rebasing commit";

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

	/** Opens the unstaged file's diff in the centre pane. */
	async openFile(path: string): Promise<void> {
		const row = await waitFor(`the unstaged ${path} row`, () =>
			firstMatching(`${UNSTAGED_SECTION} ${FILE_ROW}`, (text) =>
				text.includes(path),
			),
		);

		row.click();
	}

	/** The `@@` header of each hunk the diff pane is showing, topmost first. */
	hunkHeaders(): string[] {
		const headers = document.querySelectorAll<HTMLElement>(HUNK_HEADER);

		return [...headers].map((header) => header.textContent?.trim() ?? "");
	}

	/** The files the panel is showing as unstaged, topmost first. */
	unstagedFiles(): string[] {
		return filesIn(UNSTAGED_SECTION);
	}

	/** The files the panel is showing as staged, topmost first. */
	stagedFiles(): string[] {
		return filesIn(STAGED_SECTION);
	}

	/** The content of every added row in the diff pane, topmost first. */
	addedLines(): string[] {
		const rows = document.querySelectorAll<HTMLElement>(ADDED_LINE);

		return [...rows].map((row) => row.textContent?.trim() ?? "");
	}

	/** Stages the hunk at `ordinal`, topmost first. */
	async stageHunk(ordinal: number): Promise<void> {
		const button = await waitFor(`${STAGE_HUNK} on hunk ${ordinal}`, () =>
			enabledAction(ordinal, STAGE_HUNK),
		);

		button.click();
	}

	/** What the rebase banner is offering the user, or null while the panel is
	 *  showing no operation in progress. */
	banner(): string[] | null {
		const panel = firstMatching("div", (text) =>
			text.startsWith(REBASE_PROGRESS),
		);
		if (!panel) return null;

		return [...panel.querySelectorAll("button")].map(
			(action) => action.textContent?.trim() ?? "",
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

function filesIn(section: string): string[] {
	const rows = document.querySelectorAll<HTMLElement>(`${section} ${FILE_ROW}`);

	return [...rows].map((row) => row.textContent?.trim() ?? "");
}

/**
 * The hunk toolbar's action, or null while it is disabled. `hunkOperationInFlight`
 * disables every staging button for the length of a call, and jsdom dispatches
 * no click on a disabled button: a gesture issued early does nothing, quietly.
 */
function enabledAction(ordinal: number, label: string): HTMLButtonElement | null {
	const toolbar = document.querySelectorAll<HTMLElement>(HUNK_TOOLBAR)[ordinal];
	if (!toolbar) return null;

	const action = [...toolbar.querySelectorAll("button")].find((button) =>
		(button.textContent?.trim() ?? "").startsWith(label),
	);

	return action && !action.disabled ? action : null;
}

function stageAllButton(): HTMLElement | null {
	return document.querySelector<HTMLElement>(STAGE_ALL);
}

function workingTreeRow(): HTMLElement | null {
	return firstMatching(COMMIT_ROW, (text) => text.includes(WIP_PLACEHOLDER));
}
