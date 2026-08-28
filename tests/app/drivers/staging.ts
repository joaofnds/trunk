import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const COMMIT_ROW = '[data-testid="commit-row"]';
const UNSTAGED_SECTION = '[data-testid="staging-unstaged-section"]';
const FILE_ROW = '[data-testid="staging-file"]';
const STAGED_SECTION = '[data-testid="staging-staged-section"]';
const HUNK_TOOLBAR = ".hunk-toolbar";
const HUNK_HEADER = `${HUNK_TOOLBAR} .hunk-header-text`;
const DIFF_LINE = ".diff-line";
const LINE_CONTENT = ".diff-line-content";
const ADDED_LINE = `.diff-line-add ${LINE_CONTENT}`;
const GRIP = ".gutter-selectable";
const STAGE_HUNK = "Stage Hunk";
const DISCARD_LINES = "Discard Lines";
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
			enabledIn(toolbars()[ordinal], STAGE_HUNK),
		);

		button.click();
	}

	/** Selects every row from the one reading `first` to the one reading `last`,
	 *  the shift-click a user makes on the gutter. */
	async selectLines(first: string, last: string): Promise<void> {
		const from = await waitFor(`the grip on ${first}`, () => grip(first));
		const to = await waitFor(`the grip on ${last}`, () => grip(last));

		from.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		to.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, shiftKey: true }),
		);
	}

	/** Discards the selected lines. The confirmation goes to the dialog Fake,
	 *  which dismisses unless the test has said otherwise. */
	async discardSelectedLines(): Promise<void> {
		const button = await waitFor(`${DISCARD_LINES} on the selection`, () =>
			offeredAnywhere(DISCARD_LINES),
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

function toolbars(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(HUNK_TOOLBAR)];
}

/**
 * The toolbar's action, or null while it is disabled. `hunkOperationInFlight`
 * disables every staging button for the length of a call, and jsdom dispatches
 * no click on a disabled button: a gesture issued early does nothing, quietly.
 */
function enabledIn(
	toolbar: HTMLElement | undefined,
	label: string,
): HTMLButtonElement | null {
	if (!toolbar) return null;

	const action = [...toolbar.querySelectorAll("button")].find((button) =>
		(button.textContent?.trim() ?? "").startsWith(label),
	);

	return action && !action.disabled ? action : null;
}

/** The action wherever a toolbar is offering it: a selection lives in one hunk,
 *  and which one is the test's business rather than the driver's. */
function offeredAnywhere(label: string): HTMLButtonElement | null {
	for (const toolbar of toolbars()) {
		const action = enabledIn(toolbar, label);
		if (action) return action;
	}

	return null;
}

function grip(content: string): HTMLElement | null {
	const cell = firstMatching(LINE_CONTENT, (text) => text === content);

	return cell?.closest(DIFF_LINE)?.querySelector<HTMLElement>(GRIP) ?? null;
}

function stageAllButton(): HTMLElement | null {
	return document.querySelector<HTMLElement>(STAGE_ALL);
}

function workingTreeRow(): HTMLElement | null {
	return firstMatching(COMMIT_ROW, (text) => text.includes(WIP_PLACEHOLDER));
}
