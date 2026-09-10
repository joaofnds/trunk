import type { ReviewFilter } from "../../../src/lib/types.js";
import { waitFor } from "../harness/wait.js";

const REVIEW_FILTER = '[aria-label="Review filter selection"]';
const REVIEW = '[aria-label="Review"]';
const VIEW_BADGE = '[aria-label$="review comments in this view"]';
const HUNK_TOOLBAR = ".hunk-toolbar";
const COMMENT = "Comment";
const COMPOSER_TEXT = ".composer-textarea";
const SUBMIT = ".submit-btn";
const CARD = ".comment-card";
const PROBE = ".comment-probe";
const FILE_REF = ".comment-card-fileref";
const STATE_CHIP = ".thread-state-chip";
const CARD_ACTION = ".card-action";
const ORPHAN_BADGE = ".orphan-badge";
const PUBLISH = ".publish-button";
const CONFIRM_PUBLISH = "Click again to confirm";
const COPY = ".copy-button";
const MARK_DONE = "Mark done";
const DISMISS = "Dismiss";
const COMMENT_ON_FILE = ".comment-on-file-button";
const FINDER_INPUT = '[aria-label="Find a tracked file to comment on"]';
const FINDER_ROW = '[role="option"]';
const SELECTABLE_LINE = ".gutter-selectable";
const FULL_FILE_COMMENT = ".full-file-comment-button";
const JUMP_TO_CODE = '[aria-label="Jump to code"]';
const DIFF_PATH = '[data-testid="diff-path"]';
const REPLY_TEXT = 'textarea[aria-label="Reply"]';
const REPLY_BODY = ".thread-reply-text";
const ROOT_EDIT_TEXT = ".comment-card-body textarea";
const REPLY_EDIT_TEXT = 'textarea[aria-label="Edit reply"]';
const COMMIT_NOTES = ".commit-notes";
const COMMIT_NOTE_TEXT = 'textarea[placeholder="Leave a note on this commit…"]';

/**
 * A review, from the comment that creates it to the doc it renders. Every
 * gesture waits for its control to be enabled before clicking: the composer's
 * Submit is dead until the text is non-empty, and End review and Copy are dead
 * until the review has a comment. jsdom dispatches no click on a disabled
 * button, so a gesture issued early does nothing, quietly.
 */
export class ReviewDriver {
	/** Selects a review-thread presentation and waits for its visible effect. */
	async showReviewFilter(
		filterValue: ReviewFilter,
		observePresentation: () => boolean,
	): Promise<void> {
		const filter = await waitFor("the review filter", () =>
			selectEnabled(REVIEW_FILTER),
		);

		if (filter.value !== filterValue) {
			filter.value = filterValue;
			filter.dispatchEvent(new Event("change", { bubbles: true }));
		}

		await waitFor(`the review filter to become ${filterValue}`, () => {
			const current = document.querySelector<HTMLSelectElement>(REVIEW_FILTER);
			return current?.value === filterValue && observePresentation()
				? true
				: null;
		});
	}

	/** Comments the hunk at `ordinal`, topmost first. With no line selection this
	 *  is the whole-hunk affordance. */
	async commentOnHunk(ordinal: number): Promise<void> {
		const button = await waitFor(`${COMMENT} on hunk ${ordinal}`, () =>
			enabledIn(toolbars()[ordinal], COMMENT),
		);

		button.click();
	}

	/** Clicks the gutter of the 1-based `lineno`-th selectable line in the pane,
	 *  which is the gesture that arms the full-file Comment affordance. */
	async selectLine(lineno: number): Promise<void> {
		const gutter = await waitFor(`line ${lineno} in the pane`, () => {
			const lines = [
				...document.querySelectorAll<HTMLElement>(SELECTABLE_LINE),
			];
			return lines[lineno - 1] ?? null;
		});

		gutter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		gutter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	}

	/** Selects the visible new-side gutter whose displayed line number matches. */
	async selectNewLine(lineno: number): Promise<void> {
		const gutter = await waitFor(
			`new line ${lineno} in the pane`,
			() =>
				[...document.querySelectorAll<HTMLElement>(SELECTABLE_LINE)].find(
					(line) =>
						line
							.querySelectorAll<HTMLElement>(".gutter-num")[1]
							?.textContent?.trim() === String(lineno),
				) ?? null,
		);

		gutter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		gutter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	}

	/** Presses the Comment affordance the line selection arms. */
	async commentOnSelection(): Promise<void> {
		const button = await waitFor("the full-file Comment affordance", () =>
			enabled(FULL_FILE_COMMENT),
		);

		button.click();
	}

	/** Types into the open composer. */
	async write(text: string): Promise<void> {
		const field = await waitFor("the open composer", () =>
			visibleElement<HTMLTextAreaElement>(COMPOSER_TEXT),
		);

		field.value = text;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** The visible composer's unsent text and captured line range. */
	composerDraft(): { text: string; range: string } | null {
		const field = visibleElement<HTMLTextAreaElement>(COMPOSER_TEXT);
		const composer = field?.closest<HTMLElement>(".comment-composer");
		return field && composer
			? { text: field.value, range: textIn(composer, ".composer-preview") }
			: null;
	}

	/** Types an unsent reply on the first visible thread. */
	async writeReply(text: string): Promise<void> {
		const field = await waitFor(
			"the thread reply composer",
			() => cards()[0]?.querySelector<HTMLTextAreaElement>(REPLY_TEXT) ?? null,
		);
		field.value = text;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	replyDraft(): string | null {
		return (
			cards()[0]?.querySelector<HTMLTextAreaElement>(REPLY_TEXT)?.value ?? null
		);
	}

	async submitReply(): Promise<void> {
		const button = await waitFor("an enabled reply button", () =>
			enabledIn(cards()[0], "Reply"),
		);
		button.click();
	}

	replies(): string[] {
		return [
			...(cards()[0]?.querySelectorAll<HTMLElement>(REPLY_BODY) ?? []),
		].map(collapse);
	}

	async startRootEdit(): Promise<void> {
		const button = await waitFor("the root comment edit control", () =>
			enabledIn(cards()[0], "Edit"),
		);
		button.click();
		await waitFor("the root comment editor", () =>
			visibleElement<HTMLTextAreaElement>(ROOT_EDIT_TEXT),
		);
	}

	async writeRootEdit(text: string): Promise<void> {
		await writeVisible(ROOT_EDIT_TEXT, text, "the root comment editor");
	}

	rootEditDraft(): string | null {
		return visibleElement<HTMLTextAreaElement>(ROOT_EDIT_TEXT)?.value ?? null;
	}

	async saveRootEdit(): Promise<void> {
		const editor = await waitFor("the root comment editor", () =>
			visibleElement<HTMLTextAreaElement>(ROOT_EDIT_TEXT),
		);
		const button = await waitFor("the root comment save control", () =>
			enabledIn(editor.closest<HTMLElement>(".comment-card-body"), "Save"),
		);
		button.click();
	}

	async startReplyEdit(): Promise<void> {
		const button = await waitFor("the reply edit control", () =>
			enabledIn(cards()[0], "Edit reply"),
		);
		button.click();
		await waitFor("the reply editor", () =>
			visibleElement<HTMLTextAreaElement>(REPLY_EDIT_TEXT),
		);
	}

	async writeReplyEdit(text: string): Promise<void> {
		await writeVisible(REPLY_EDIT_TEXT, text, "the reply editor");
	}

	replyEditDraft(): string | null {
		return visibleElement<HTMLTextAreaElement>(REPLY_EDIT_TEXT)?.value ?? null;
	}

	async saveReplyEdit(): Promise<void> {
		const editor = await waitFor("the reply editor", () =>
			visibleElement<HTMLTextAreaElement>(REPLY_EDIT_TEXT),
		);
		const button = await waitFor("the reply edit save control", () =>
			enabledIn(editor.closest<HTMLElement>(".thread-reply"), "Save"),
		);
		button.click();
	}

	async startCommitNote(): Promise<void> {
		const notes = await waitFor("the focused commit notes", () =>
			visibleElement<HTMLElement>(COMMIT_NOTES),
		);
		const button = await waitFor("the add-note control", () =>
			enabledIn(notes, "Add note"),
		);
		button.click();
		await waitFor("the commit note editor", () =>
			visibleElement<HTMLTextAreaElement>(COMMIT_NOTE_TEXT),
		);
	}

	async writeCommitNote(text: string): Promise<void> {
		await writeVisible(COMMIT_NOTE_TEXT, text, "the commit note editor");
	}

	commitNoteDraft(): string | null {
		return visibleElement<HTMLTextAreaElement>(COMMIT_NOTE_TEXT)?.value ?? null;
	}

	async saveCommitNote(): Promise<void> {
		const editor = await waitFor("the commit note editor", () =>
			visibleElement<HTMLTextAreaElement>(COMMIT_NOTE_TEXT),
		);
		const button = await waitFor("the commit note save control", () =>
			enabledIn(editor.closest<HTMLElement>(".add-note-composer"), "Save"),
		);
		button.click();
	}

	/** Leaves the panel for the first visible thread's diff. */
	async jumpToThread(): Promise<void> {
		const button = await waitFor("the thread's jump to code", () =>
			enabled(JUMP_TO_CODE),
		);
		button.click();
		await waitFor("the thread's diff", () =>
			document.querySelector(DIFF_PATH) ? true : null,
		);
	}

	/** Dismisses the thread anchored at `fileRef` and waits for its saved state. */
	async dismissThread(fileRef: string): Promise<void> {
		const button = await waitFor(`Dismiss on ${fileRef}`, () =>
			enabledIn(cardFor(fileRef), DISMISS),
		);
		button.click();
		await waitFor(`${fileRef} to become dismissed`, () => {
			const card = cardFor(fileRef);
			return card && textIn(card, STATE_CHIP) === "dismissed" ? true : null;
		});
	}

	/** Submits the composer, which is what sends the comment. */
	async submit(): Promise<void> {
		const button = await waitFor("an enabled submit button", () =>
			enabled(SUBMIT),
		);

		button.click();
	}

	/** Presses the toolbar's Review button, swapping the center pane to the
	 *  review panel. */
	async openPanel(): Promise<void> {
		const button = await waitFor("the review button", () => enabled(REVIEW));

		button.click();
	}

	/** Closes the review panel and returns to the repository layout. */
	async closePanel(): Promise<void> {
		const button = await waitFor("the review button", () => enabled(REVIEW));
		button.click();
		await waitFor("the review panel to close", () =>
			cards().length === 0 ? true : null,
		);
	}

	/** Opens the file finder from the review panel header. */
	async openFileFinder(): Promise<void> {
		const button = await waitFor("the comment-on-a-file button", () =>
			enabled(COMMENT_ON_FILE),
		);

		button.click();
	}

	/** Types into the open finder, which narrows its list. */
	async findFile(query: string): Promise<void> {
		const field = await waitFor("the open file finder", () =>
			document.querySelector<HTMLInputElement>(FINDER_INPUT),
		);

		field.value = query;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** The paths the finder currently lists, best match first. */
	finderRows(): string[] {
		return [...document.querySelectorAll<HTMLElement>(FINDER_ROW)].map(
			collapse,
		);
	}

	finderVisible(): boolean {
		return document.querySelector(FINDER_INPUT) !== null;
	}

	finderBadge(): { count: number; background: string } | null {
		const badge = document.querySelector<HTMLElement>(".finder-comment-count");
		if (!badge) return null;

		return {
			count: Number(badge.textContent?.trim()),
			background: badge.style.background,
		};
	}

	/** Opens the finder's topmost row, which is the one enter would take. */
	async openTopFinderRow(): Promise<void> {
		const row = await waitFor("a finder row", () => {
			const first = document.querySelector<HTMLButtonElement>(FINDER_ROW);
			return first && !first.disabled ? first : null;
		});

		row.click();
	}

	/** The file each thread card is anchored to, topmost first. */
	threads(): string[] {
		return cards().map((card) => textIn(card, FILE_REF));
	}

	/** The orphan badge each thread card carries, topmost first, empty where a
	 *  card carries none. This is what a user sees when a comment no longer
	 *  resolves against the repository. */
	orphanBadges(): string[] {
		return cards().map((card) => textIn(card, ORPHAN_BADGE));
	}

	/** The state chip each thread card carries, topmost first. */
	states(): string[] {
		return cards().map((card) => textIn(card, STATE_CHIP));
	}

	/** Reads the badge on the Review button, or null when the count is hidden. */
	reviewBadgeCount(): number | null {
		const badge = document.querySelector<HTMLElement>(
			`${REVIEW} .toolbar-badge`,
		);
		if (!badge) return null;

		const value = collapse(badge);
		if (!value) return null;

		const count = Number(value);
		return Number.isFinite(count) ? count : null;
	}

	/** The semantic tone on the Review toolbar count pill. */
	reviewBadgeTone(): string | null {
		const badge = document.querySelector<HTMLElement>(
			`${REVIEW} .toolbar-badge`,
		);
		return (
			[...(badge?.classList ?? [])]
				.find((name) => name.startsWith("tone-"))
				?.slice("tone-".length) ?? null
		);
	}

	/** The count on the toolbar pill for comments in the current diff. */
	viewBadgeCount(): number | null {
		const badge = document.querySelector<HTMLElement>(VIEW_BADGE);
		const count = Number(badge?.textContent?.trim());
		return badge && Number.isFinite(count) ? count : null;
	}

	/** The semantic tone on the current-diff toolbar pill. */
	viewBadgeTone(): string | null {
		const badge = document.querySelector<HTMLElement>(VIEW_BADGE);
		return (
			[...(badge?.classList ?? [])]
				.find((name) => name.startsWith("tone-"))
				?.slice("tone-".length) ?? null
		);
	}

	/** What the topmost thread card offers the user. */
	actions(): string[] {
		const card = cards()[0];
		if (!card) return [];

		return [...card.querySelectorAll<HTMLElement>(CARD_ACTION)].map(collapse);
	}

	/** Ends the review, which publishes it. Two clicks: the first arms a confirm
	 *  that reverts after 3000 ms, and the second is the one that publishes. */
	async publish(): Promise<void> {
		const button = await waitFor("an enabled end-review button", () =>
			enabled(PUBLISH),
		);

		button.click();

		const confirm = await waitFor("the end-review confirmation", () =>
			collapse(button) === CONFIRM_PUBLISH ? button : null,
		);

		confirm.click();
	}

	/** Takes the topmost thread to `done`, the gesture only a human has. */
	async markDone(): Promise<void> {
		const button = await waitFor(`${MARK_DONE} on the topmost thread`, () =>
			enabledIn(cards()[0], MARK_DONE),
		);

		button.click();
	}

	/** Copies the review doc, which is what renders it. */
	async copyDoc(): Promise<void> {
		const button = await waitFor("an enabled copy button", () => enabled(COPY));

		button.click();
	}
}

function toolbars(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(HUNK_TOOLBAR)];
}

/**
 * The thread cards the user can see. `HunkView` renders every thread a second
 * time inside a hidden probe to measure its height, so a query that names the
 * card alone answers with the probe's copy — and answers it whether or not the
 * panel ever opened. The panel also keeps filtered cards mounted; their hidden
 * ancestors remove them from the visible thread list.
 */
function cards(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(CARD)].filter(
		(card) => !card.closest(PROBE) && visible(card),
	);
}

function cardFor(fileRef: string): HTMLElement | undefined {
	return cards().find((card) => textIn(card, FILE_REF) === fileRef);
}

function visible(element: HTMLElement): boolean {
	for (
		let node: HTMLElement | null = element;
		node;
		node = node.parentElement
	) {
		const style = getComputedStyle(node);
		if (
			node.hidden ||
			style.display === "none" ||
			style.visibility === "hidden"
		) {
			return false;
		}
	}
	return true;
}

function visibleElement<T extends HTMLElement>(selector: string): T | null {
	return [...document.querySelectorAll<T>(selector)].find(visible) ?? null;
}

function textIn(card: HTMLElement, selector: string): string {
	const node = card.querySelector(selector);

	return node ? collapse(node) : "";
}

function enabled(selector: string): HTMLButtonElement | null {
	const control = visibleElement<HTMLButtonElement>(selector);

	return control && !control.disabled ? control : null;
}

function selectEnabled(selector: string): HTMLSelectElement | null {
	const control = document.querySelector<HTMLSelectElement>(selector);

	return control && !control.disabled ? control : null;
}

function enabledIn(
	container: HTMLElement | null | undefined,
	label: string,
): HTMLButtonElement | null {
	if (!container) return null;

	const action = [...container.querySelectorAll("button")].find((button) =>
		collapse(button).startsWith(label),
	);

	return action && !action.disabled ? action : null;
}

function collapse(node: Element): string {
	return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function writeVisible(
	selector: string,
	text: string,
	description: string,
): Promise<void> {
	const field = await waitFor(description, () =>
		visibleElement<HTMLTextAreaElement>(selector),
	);
	field.value = text;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
