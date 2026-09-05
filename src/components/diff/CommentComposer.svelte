<script lang="ts">
import { untrack } from "svelte";
import { buildDiffAnchor } from "../../lib/diff-anchor.js";
import { reportErrorToast } from "../../lib/error-report.js";
import { safeInvoke } from "../../lib/invoke.js";
import { createOwnedTimer } from "../../lib/owned-timer.js";
import {
	deleteDraft,
	getDraft,
	saveDraft,
} from "../../lib/review-comment-actions.js";
import type { Anchor, FileDiff } from "../../lib/types.js";

interface Props {
	// Diff path passes file/hunkIdx/selectedLineIndices and the composer derives
	// the captured result via buildDiffAnchor. The full-file host instead injects
	// a pre-built `captured` result (from buildFullFileAnchor) and omits the three
	// diff-path props. Exactly one of the two contracts is satisfied by the caller.
	captured?: { anchor: Anchor; cachedExcerpt: string };
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
}

let {
	captured,
	file,
	hunkIdx,
	selectedLineIndices,
	commitOid,
	resolveCommitOid,
	repoPath,
	onclose,
}: Props = $props();

let text = $state("");
let submitting = $state(false);

// Restore the draft this repo autosaved. The row has no review foreign key, so
// it survives a crash or a quit without stranding a review (D6) — but only if
// something reads it back, which is what makes the restore real rather than
// write-only. Runs once per mount, before the user can type: a later arrival
// must not clobber what they have already written.
let restored = $state(false);
$effect(() => {
	void repoPath;
	untrack(async () => {
		try {
			const draft = await getDraft(repoPath);
			if (draft !== null && text === "") text = draft.text;
		} catch {
			// A missing draft is the normal case; a failed read costs the restore,
			// never the composer.
		} finally {
			restored = true;
		}
	});
});

// Focus the textarea as soon as the composer mounts (it mounts fresh on each open)
// so the user can type immediately without clicking into it.
let textareaEl = $state<HTMLTextAreaElement | null>(null);
$effect(() => {
	textareaEl?.focus();
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

const submitDisabled = $derived(text.trim() === "" || submitting);

function scheduleDraftSave() {
	draftSave.arm(() => void persistDraft(), DRAFT_DEBOUNCE_MS);
}

// The autosave is an IPC call with no cancel, so anything that writes the draft
// row after it waits for it to land, or a save arriving last brings the draft back.
let saveInFlight: Promise<void> = Promise.resolve();

async function persistDraft() {
	// Never write before the restore has landed: an empty autosave racing the
	// read would erase the draft it is about to restore.
	if (!restored) return;

	saveInFlight = saveDraft(repoPath, text, capturedResult.anchor).catch((e) =>
		reportErrorToast(e, "Save draft failed"),
	);
	await saveInFlight;
}

async function settleDraftSave() {
	draftSave.cancel();
	await saveInFlight;
}

async function discardDraft() {
	await settleDraftSave();
	try {
		await deleteDraft(repoPath);
	} catch (e) {
		reportErrorToast(e, "Discard draft failed");
	}
}

async function handleSubmit() {
	if (submitDisabled) return;

	submitting = true;
	await settleDraftSave();
	try {
		// Resolve the anchor's commit_oid now (deferred from open): for the working
		// tree this starts the session + creates/reuses the snapshot. Null = failure
		// (a toast already fired); keep the composer + draft open so nothing is lost.
		let anchor = capturedResult.anchor;
		if (resolveCommitOid) {
			const oid = await resolveCommitOid();
			if (oid === null) return;
			anchor = { ...anchor, commit_oid: oid };
		}
		await safeInvoke("add_thread", {
			path: repoPath,
			text,
			anchor,
			cachedExcerpt: capturedResult.cachedExcerpt,
		});
	} catch (e) {
		reportErrorToast(e, "Add comment failed");
		return;
	} finally {
		submitting = false;
	}
	text = "";
	onclose();
}

// Cancelling abandons the draft, so the row goes with it — otherwise the next
// composer reopens with text the user already chose to discard.
async function handleCancel() {
	await discardDraft();
	text = "";
	onclose();
}

// Instance method the host (DiffPanel) calls before switching the selection to a
// new range. Confirms only when the draft is dirty (non-empty); an empty draft
// switches silently. Mirrors DiffPanel.handleDiscardLines' confirm pattern.
export async function confirmDiscardIfDirty(): Promise<boolean> {
	if (text.trim() === "") return true;

	const { ask } = await import("@tauri-apps/plugin-dialog");
	const discard = await ask("Discard your unsaved comment?", {
		title: "Discard Comment",
		kind: "warning",
	});
	if (discard) await discardDraft();

	return discard;
}
</script>

<div class="comment-composer">
	<div class="composer-preview">
		Comments on lines {capturedResult.anchor.start_line}-{capturedResult.anchor.end_line}
	</div>
	<textarea
		bind:this={textareaEl}
		class="composer-textarea"
		placeholder="Leave a comment on these lines…"
		bind:value={text}
		oninput={scheduleDraftSave}
	></textarea>
	<div class="composer-actions">
		<button class="composer-btn cancel-btn" onclick={handleCancel}>Cancel</button>
		<button
			class="composer-btn submit-btn"
			disabled={submitDisabled}
			style="cursor: {submitDisabled ? 'not-allowed' : 'pointer'}; opacity: {submitDisabled ? 0.4 : 1};"
			onclick={handleSubmit}
		>Submit</button>
	</div>
</div>

<style>
	.comment-composer {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
	}

	.composer-preview {
		color: var(--color-text-muted);
		font-size: 11px;
		font-family: var(--font-mono, monospace);
	}

	.composer-textarea {
		min-height: 60px;
		resize: vertical;
		padding: var(--space-2);
		font-size: 12px;
		font-family: var(--font-sans, sans-serif);
		color: var(--color-text);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		box-sizing: border-box;
	}

	.composer-textarea:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.composer-btn {
		border-radius: var(--radius);
		font-size: 11px;
		font-family: var(--font-sans, sans-serif);
		padding: var(--space-1) var(--space-3);
		white-space: nowrap;
		cursor: pointer;
	}

	.cancel-btn {
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
	}

	.submit-btn {
		background: var(--color-success-bg);
		border: 1px solid var(--color-success-border);
		color: var(--color-success);
	}
</style>
