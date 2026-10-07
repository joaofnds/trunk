<script lang="ts">
import MessageSquare from "@lucide/svelte/icons/message-square";
import { untrack } from "svelte";
import { buildDiffAnchor } from "../../lib/diff-anchor.js";
import { reportErrorToast } from "../../lib/error-report.js";
import { safeInvoke } from "../../lib/invoke.js";
import { createOwnedTimer } from "../../lib/owned-timer.js";
import {
	askToDiscardComment,
	deleteDraft,
	getDraft,
	saveDraft,
} from "../../lib/review-comment-actions.js";
import {
	createReviewComposerSession,
	type ReviewComposerSession,
} from "../../lib/review-editors.svelte.js";
import type { Anchor, Delivery, FileDiff, Review } from "../../lib/types.js";
import ComposerFrame from "../review/ComposerFrame.svelte";

interface Props {
	// Diff path passes file/hunkIdx/selectedLineIndices and the composer derives
	// the captured result via buildDiffAnchor. The full-file host instead injects
	// a pre-built `captured` result (from buildFullFileAnchor) and omits the three
	// diff-path props. Exactly one of the two contracts is satisfied by the caller.
	captured?: { anchor: Anchor; cachedExcerpt: string; wholeFile?: boolean };
	// The current-file contract, exclusive with the other two. A current-file
	// thread pins the file's own content, so it carries no anchor and no commit
	// oid: the backend reads the range out of the file at submit and stores the
	// block it found. Sending a block from here would let the two disagree.
	currentFile?: { filePath: string; startLine: number; endLine: number };
	file?: FileDiff;
	hunkIdx?: number;
	selectedLineIndices?: Set<number>;
	commitOid: string;
	// Deferred commit_oid resolver (260531-l02 lag fix). When present, submit calls it
	// to get the anchor's real commit_oid — for the working tree this starts the
	// session and creates/reuses the snapshot commit, work kept OFF the open path so
	// the composer appears instantly. Returns null on failure (submit aborts, draft
	// kept). When absent, the anchor's own commit_oid is used as-is.
	resolveCommitOid?: () => Promise<string | null>;
	repoPath: string;
	onclose: () => void;
	/** Whether the host stretches the range on a shift-click on a line number. */
	extendable?: boolean;
	/** Hide-all keeps the editor mounted but must make submission impossible. */
	canSubmit?: boolean;
	/** The review active when this composer was opened. */
	originatingReviewId?: string | null;
	/** The review currently active in the host. */
	activeReviewId?: string | null;
	/** Repository-tab-owned submission latch that survives conditional mounts. */
	composerSession?: ReviewComposerSession;
	/** The active review's id, title and held count, null while the host has
	 *  not read them. */
	activeReview?: Pick<Review, "id" | "title" | "pending_count"> | null;
}

let {
	captured,
	currentFile,
	file,
	hunkIdx,
	selectedLineIndices,
	commitOid,
	resolveCommitOid,
	repoPath,
	onclose,
	canSubmit = true,
	originatingReviewId = null,
	activeReviewId = null,
	composerSession,
	activeReview = null,
	extendable = false,
}: Props = $props();

const localSession = createReviewComposerSession();
const activeSession = $derived(composerSession ?? localSession);
const composerDraft = $derived(activeSession.draft);
const submitting = $derived(activeSession.submitting);

function anchorsEqual(left: Anchor | null, right: Anchor | null): boolean {
	return (
		left?.commit_oid === right?.commit_oid &&
		left?.file_path === right?.file_path &&
		left?.source === right?.source &&
		left?.side === right?.side &&
		left?.start_line === right?.start_line &&
		left?.end_line === right?.end_line
	);
}

$effect(() => {
	const session = activeSession;
	const path = repoPath;
	untrack(async () => {
		const anchor = capturedResult.anchor;
		try {
			await session.restoreDraft(async () => {
				const draft = await getDraft(path);
				if (!draft || !anchorsEqual(draft.anchor, anchor)) return null;
				return draft.text;
			});
		} catch (error) {
			reportErrorToast(error, "Restore draft failed");
		}
	});
});

const DRAFT_DEBOUNCE_MS = 300;
const draftSave = createOwnedTimer();

// The capture-time adapter is the single source of truth for both the persisted
// range (start_line..end_line) and the excerpt. When the host injects a captured
// result (full-file path) use it directly; otherwise derive it from the diff-path
// props. The diff-path caller (DiffPanel.svelte) guards composerOpen &&
// composerFile && composerHunkIdx !== null before mounting, so the three optional
// props are always defined on that path; the throw branch documents the contract
// rather than handling a reachable case.
function deriveDiffCapture(): { anchor: Anchor; cachedExcerpt: string } {
	if (
		file === undefined ||
		hunkIdx === undefined ||
		selectedLineIndices === undefined
	) {
		throw new Error(
			"CommentComposer: diff-path props missing — caller contract violated",
		);
	}
	return buildDiffAnchor(commitOid, file, hunkIdx, selectedLineIndices);
}
const capturedResult = $derived(captured ?? deriveDiffCapture());

const reviewMatches = $derived(originatingReviewId === activeReviewId);
const batchHeld = $derived((activeReview?.pending_count ?? 0) > 0);
const submitDisabled = $derived(
	!canSubmit ||
		!reviewMatches ||
		composerDraft.text.trim() === "" ||
		submitting,
);

function scheduleDraftSave() {
	draftSave.arm(() => void persistDraft(), DRAFT_DEBOUNCE_MS);
}

// The autosave is an IPC call with no cancel, so anything that writes the draft
// row after it waits for it to land, or a save arriving last brings the draft back.
let saveInFlight: Promise<void> = Promise.resolve();

async function persistDraft() {
	// Never write before the restore has landed: an empty autosave racing the
	// read would erase the draft it is about to restore.
	if (!activeSession.restoreSettled) return;

	saveInFlight = saveDraft(
		repoPath,
		composerDraft.text,
		capturedResult.anchor,
	).catch((e) => reportErrorToast(e, "Save draft failed"));
	await saveInFlight;
}

async function settleDraftSave() {
	draftSave.cancel();
	await saveInFlight;
}

async function discardDraft(path: string) {
	await settleDraftSave();
	try {
		await deleteDraft(path);
	} catch (e) {
		reportErrorToast(e, "Discard draft failed");
	}
}

async function handleSubmit(delivery: Delivery) {
	const submittedDraft = composerDraft;
	const submittedText = composerDraft.text;
	const submittedRevision = submittedDraft.revision;
	const submittedCaptured = capturedResult;
	const submittedCurrentFile = currentFile;
	const submittedResolveCommitOid = resolveCommitOid;
	const submittedComposerSession = activeSession;
	const submittedReviewId = originatingReviewId;
	const submittedRepoPath = repoPath;
	const submittedOnClose = onclose;
	if (submitDisabled) return;

	submittedComposerSession.setSubmitting(true);
	await settleDraftSave();
	try {
		if (submittedReviewId !== activeReviewId) return;
		// Resolve the anchor's commit_oid now (deferred from open): for the working
		// tree this starts the session + creates/reuses the snapshot. Null = failure
		// (a toast already fired); keep the composer + draft open so nothing is lost.
		if (submittedCurrentFile) {
			await safeInvoke("add_current_file_thread", {
				path: submittedRepoPath,
				filePath: submittedCurrentFile.filePath,
				startLine: submittedCurrentFile.startLine,
				endLine: submittedCurrentFile.endLine,
				text: submittedText,
				delivery,
			});
		} else {
			let anchor = submittedCaptured.anchor;
			if (submittedResolveCommitOid) {
				const oid = await submittedResolveCommitOid();
				if (oid === null) return;
				if (submittedReviewId !== activeReviewId) return;
				anchor = { ...anchor, commit_oid: oid };
			}
			await safeInvoke("add_thread", {
				path: submittedRepoPath,
				text: submittedText,
				anchor,
				cachedExcerpt: submittedCaptured.cachedExcerpt,
				delivery,
			});
		}
	} catch (e) {
		reportErrorToast(e, "Add comment failed");
		return;
	} finally {
		submittedComposerSession.setSubmitting(false);
	}
	if (submittedDraft.revision === submittedRevision) {
		submittedDraft.close();
		submittedOnClose();
	}
}

// Cancelling abandons the draft, so the row goes with it — otherwise the next
// composer reopens with text the user already chose to discard.
async function handleCancel() {
	if (submitting) return;
	const session = activeSession;
	const draft = session.draft;
	const revision = draft.revision;
	const close = onclose;
	const path = repoPath;
	session.setSubmitting(true);
	try {
		await discardDraft(path);
		if (draft.revision !== revision) return;
		draft.close();
		close();
	} finally {
		session.setSubmitting(false);
	}
}

function rangeHeading(start: number, end: number): string {
	return start === end
		? `Comment on line ${start}`
		: `Comments on lines ${start}-${end}`;
}

// Instance method the host (DiffPanel) calls before switching the selection to a
// new range. Confirms only when the draft is dirty (non-empty); an empty draft
// switches silently. Mirrors DiffPanel.handleDiscardLines' confirm pattern.
export async function confirmDiscardIfDirty(): Promise<boolean> {
	if (submitting) return false;
	const session = activeSession;
	const revision = session.draft.revision;
	const path = repoPath;
	if (!session.draft.valid) return true;

	const discard = await askToDiscardComment();
	if (
		!discard ||
		session !== activeSession ||
		session.draft.revision !== revision
	)
		return false;
	await discardDraft(path);
	return session === activeSession && session.draft.revision === revision;
}
</script>

<ComposerFrame
	{activeReview}
	{activeReviewId}
	placeholder="Leave a comment… Markdown supported"
	newReviewName="a new review"
	fill
	extendHint={extendable}
	bind:text={composerDraft.text}
	busy={submitting}
	submitLabel={batchHeld ? "Add to batch" : "Add comment"}
	{submitDisabled}
	onsubmit={() => void handleSubmit(batchHeld ? "hold" : "send")}
	onhold={batchHeld ? undefined : () => void handleSubmit("hold")}
	oncancel={handleCancel}
	oninput={scheduleDraftSave}
>
	{#snippet heading()}
		<MessageSquare size={12} class="shrink-0 text-accent" aria-hidden="true" />
		{#if captured?.wholeFile}
			<span
				title="Lines {capturedResult.anchor.start_line}-{capturedResult.anchor.end_line}"
				>Comment on this file</span
			>
		{:else}
			{rangeHeading(capturedResult.anchor.start_line, capturedResult.anchor.end_line)}
		{/if}
	{/snippet}
</ComposerFrame>
