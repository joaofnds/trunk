<script lang="ts">
// Renders the accumulated review grouped by commit (D-09), with a per-commit
// "Add note" affordance (D-02), inline edit (D-10), delete-with-confirm (D-05),
// and jump-to-anchor with read-only orphan rows (D-07 / D-08). The panel lives
// in the center pane (UI-SPEC:133); jump is driven by the host via onJump.

import { Check, Clipboard, MessageSquarePlus, Trash2 } from "@lucide/svelte";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { untrack } from "svelte";
import { copySha } from "../lib/clipboard.js";
import { commitOidForComment } from "../lib/comment-counts.js";
import { createDraft } from "../lib/draft.svelte.js";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	addReply,
	deleteReply,
	editReply,
	setThreadState,
} from "../lib/review-comment-actions.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import type { ReviewSessionManager } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type { CommentResolution, OrphanReason, Thread } from "../lib/types.js";
import ThreadCard from "./ThreadCard.svelte";

interface Props {
	repoPath: string;
	// The review-session rune (owned by RepoView, threaded in so the panel can
	// drive panel-internal swaps and call the Phase 70 Generate IPC via the rune).
	session: ReviewSessionManager;
	// The review session itself: lifecycle state, commits and comments. Owned by
	// RepoView, which outlives this panel — every jump into a diff destroys it.
	reviewComments: ReviewCommentsManager;
	// Resolvable-comment jump: the host (RepoView) binds this to the review-session
	// rune's jumpTo, wiring commit/file selection + scroll-to-range.
	onJump: (comment: Thread) => void;
	// Commit-header jump: select the commit and scroll the graph to it. Same
	// gesture as clicking a line ref, but without a file/line — the panel stays.
	onJumpToCommit: (commitOid: string) => void;
}

let { repoPath, session, reviewComments, onJump, onJumpToCommit }: Props =
	$props();

const commits = $derived(reviewComments.commits);
const comments = $derived(reviewComments.threads);
const reviews = $derived(reviewComments.reviews);
const activeReviewId = $derived(reviewComments.activeReviewId);
const activeReview = $derived(
	reviews.find((r) => r.id === activeReviewId) ?? null,
);

// Orphan resolution stays here: resolve_threads walks a blob per
// comment, and only this panel renders the badge it feeds.
let resolutions = $state<CommentResolution[]>([]);

// Inline add-note composer state. The per-comment edit flow now lives inside
// ThreadCard; the panel only drives the per-commit "Add note" composer, keyed
// by which commit it's open for (draft.svelte.ts owns the shared text/valid
// machinery).
let addNoteForCommit = $state<string | null>(null);
const draft = createDraft();

// LOCKED OrphanReason → badge label map (UI-SPEC § Copywriting Contract).
const ORPHAN_LABEL: Record<OrphanReason, string> = {
	CommitGone: "commit gone",
	FileGone: "file gone",
	LineOutOfRange: "line out of range",
};

// Resolution lookup by id (D-08): a comment is an orphan when its resolution
// exists and resolvable is false.
const resolutionById = $derived(new Map(resolutions.map((r) => [r.id, r])));

interface CommitGroup {
	oid: string;
	shortOid: string;
	summary: string;
	comments: Thread[];
	isSnapshot: boolean;
}

// Within a group, commit-level comments (anchor === null) sort before
// line-anchored ones — they're notes about the commit as a whole, so they read
// as the lede. Array.prototype.sort is stable on modern engines, so capture
// order is preserved within each class.
function sortGroupComments(list: Thread[]): Thread[] {
	return list.slice().sort((a, b) => {
		if (a.anchor === null && b.anchor !== null) return -1;
		if (a.anchor !== null && b.anchor === null) return 1;
		return 0;
	});
}

// Group comments by commit in the session's commit order; comments on commits
// no longer in the session (e.g. CommitGone) get a fallback group keyed by oid
// so nothing is dropped (D-08). EMPTY snapshot groups (auto-added working-tree /
// staged snapshots with no comments) are filtered out as noise; empty hand-picked
// commit groups stay so their per-commit "Add note" affordance remains (260531-l02d).
const groups = $derived.by<CommitGroup[]>(() => {
	const byOid = new Map<string, Thread[]>();
	for (const c of comments) {
		const oid = commitOidForComment(c);
		const list = byOid.get(oid) ?? [];
		list.push(c);
		byOid.set(oid, list);
	}

	const result: CommitGroup[] = [];
	const seen = new Set<string>();
	for (const commit of commits) {
		result.push({
			oid: commit.oid,
			shortOid: commit.short_oid,
			summary: commit.summary,
			comments: sortGroupComments(byOid.get(commit.oid) ?? []),
			isSnapshot: commit.is_snapshot,
		});
		seen.add(commit.oid);
	}
	// Fallback groups for comments whose commit is gone from the session.
	for (const [oid, list] of byOid) {
		if (seen.has(oid)) continue;
		// The commit isn't in session.commits — either it's actually gone from the
		// repo (the resolver will mark each comment CommitGone and the orphan badge
		// carries the truth) or it's just not added to the review. Either way, the
		// header summary is unknown here — leave it blank and let the per-comment
		// badge speak.
		result.push({
			oid,
			shortOid: oid.slice(0, 7),
			summary: "",
			comments: sortGroupComments(list),
			isSnapshot: false,
		});
	}
	// Drop empty snapshot sections — a snapshot with no comments is noise, not a
	// section to render. Empty hand-picked commits are kept (Add-note affordance).
	return result.filter(
		(group) => !(group.isSnapshot && group.comments.length === 0),
	);
});

const hasAnyComment = $derived(comments.length > 0);

let copied = $state(false);
// Plain handle, not $state — only used to clear; reactivity is on `copied`.
let copyTimer: ReturnType<typeof setTimeout> | null = null;

// Phase 73-02 — End-review two-step confirm. First click flips endConfirming
// true + arms a 3000ms revert timer; second click within the window invokes
// publish_review and lets the reviews-changed listener round-trip drive
// the panel back to the cold state (D-08 — no manual array clear). Pattern
// carry-forward from `copied` / `copyTimer` above; the danger is the timer
// leak on unmount (RESEARCH Pitfall 3) — see the $effect teardown below.
let endConfirming = $state(false);
// Plain handle, not $state — only used to clear; reactivity is on `endConfirming`.
let endTimer: ReturnType<typeof setTimeout> | null = null;

function isOrphan(c: Thread): boolean {
	const r = resolutionById.get(c.id);
	return r !== undefined && !r.resolvable;
}

function orphanLabel(c: Thread): string | null {
	const r = resolutionById.get(c.id);
	if (r === undefined || r.resolvable || r.reason === null) return null;
	return ORPHAN_LABEL[r.reason];
}

// A line-anchored, resolvable comment is jumpable; commit-level and orphaned
// comments are not (D-07 / D-08).
function isJumpable(c: Thread): boolean {
	return c.anchor !== null && !isOrphan(c);
}

// The retry the copy promises is a remount: that is what re-runs both the
// owner's refresh and the resolutions read below.
function reportReadFailure(reason: unknown) {
	const detail = errorMessage(reason, "unknown error");
	showToast(
		`Failed to load review comments: ${detail}. Reload the panel to retry.`,
		"error",
	);
}

// Generation guard. The two owners fetch independently, and this is the slow
// read of the pair — it walks to a blob per comment — so a stale answer would
// otherwise land on top of a fresh one.
let loadSeq = 0;

// resolve_threads answers for the active review, or with an empty list when the
// repo has none — a normal state, not a failure.
async function loadResolutions() {
	const seq = ++loadSeq;
	try {
		const next = await safeInvoke<CommentResolution[]>("resolve_threads", {
			path: repoPath,
		});
		if (seq !== loadSeq) return;
		resolutions = next;
	} catch (e) {
		if (seq !== loadSeq) return;
		reportReadFailure(e);
	}
}

function openAddNote(oid: string) {
	addNoteForCommit = oid;
	draft.open();
}

function cancelComposer() {
	addNoteForCommit = null;
	draft.close();
}

async function saveAddNote(oid: string) {
	if (!draft.valid) return;
	const text = draft.text;
	cancelComposer();
	try {
		await safeInvoke("add_commit_thread", {
			path: repoPath,
			commitOid: oid,
			text,
		});
	} catch (e) {
		showToast(errorMessage(e, "Failed to add note"), "error");
	}
}

async function saveEdit(id: string, text: string) {
	try {
		await safeInvoke("edit_thread", { path: repoPath, id, text });
	} catch (e) {
		showToast(errorMessage(e, "Failed to edit comment"), "error");
	}
}

// Phase 72 — Copy handler. The button is disabled by `!hasAnyComment`, so the
// no_comments TrunkError branch (from session.generate) is reachable only by a
// race (the session was emptied by another window between render and click) —
// surface it as a toast. The handler composes session.generate() (IPC, returns
// markdown string) with writeText() (clipboard plugin). Both are awaited inside
// one try/catch so a failure in either step lands in the same showToast call;
// the button never flips to "Copied" on failure. Carry-forward of the Phase 71
// preview component's Copy handler (now-deleted in Plan 04).
async function onCopyClick() {
	try {
		if (!activeReviewId) return;
		const md = await session.generate(repoPath, activeReviewId);
		await writeText(md);
		// Pitfall 2 carry-forward: clear any in-flight revert timer before
		// scheduling a new one. Rapid re-clicks must extend the affordance,
		// not race against it.
		if (copyTimer !== null) clearTimeout(copyTimer);
		copied = true;
		copyTimer = setTimeout(() => {
			copied = false;
			copyTimer = null;
		}, 1500);
	} catch (e) {
		showToast(`Failed to copy: ${errorMessage(e, "unknown error")}`, "error");
	}
}

// End-review two-step confirm. First click arms the confirming state + 3000ms
// revert; second click PUBLISHES. Publishing deletes nothing: the review stays
// listed, its threads stay visible, and the snapshot keepalive refs stay.
function startEndConfirm() {
	// clearTimeout-before-setTimeout discipline (Pattern A): rapid re-clicks
	// extend the confirm window, not race against the previous revert timer.
	if (endTimer !== null) clearTimeout(endTimer);
	endConfirming = true;
	endTimer = setTimeout(() => {
		endConfirming = false;
		endTimer = null;
	}, 3000);
}

async function onEndClick() {
	if (!endConfirming) {
		startEndConfirm();
		return;
	}
	// Second click: clear the auto-revert timer but KEEP endConfirming = true so
	// the label stays "Click again to confirm" (frozen during await). On success
	// the owner's reviews-changed refresh re-reads the now-published review and
	// the button's {#if} gate hides it. On failure we explicitly revert.
	if (endTimer !== null) {
		clearTimeout(endTimer);
		endTimer = null;
	}
	if (!activeReviewId) return;
	try {
		await safeInvoke("publish_review", {
			path: repoPath,
			reviewId: activeReviewId,
		});
	} catch (e) {
		endConfirming = false;
		// Match Plan 73-01's resume-fail shape: errorMessage() extracts only
		// `.message`; the "Failed to end review: " prefix is added by template
		// literal at the call site (RESEARCH §Pattern 2). The errorMessage
		// fallback fires only when `e` is neither Error nor TrunkError.
		const msg = errorMessage(e, "unknown error");
		showToast(`Failed to publish review: ${msg}`, "error");
	}
}

async function deleteComment(id: string) {
	try {
		await safeInvoke("delete_thread", { path: repoPath, id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to delete comment"), "error");
	}
}

// ── Review list: switch, rename, delete ─────────────────────────────────────

// Selecting a review in the list makes it active — that IS the one-step switch,
// so there is no separate "activate" affordance.
async function activateReview(id: string) {
	if (id === activeReviewId) return;
	try {
		await safeInvoke("set_active_review", { path: repoPath, reviewId: id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to switch review"), "error");
	}
}

async function startNewReview() {
	try {
		await safeInvoke("create_review", { path: repoPath, title: null });
	} catch (e) {
		showToast(errorMessage(e, "Failed to create review"), "error");
	}
}

let renamingId = $state<string | null>(null);
let renameText = $state("");

function openRename(id: string, title: string) {
	renamingId = id;
	renameText = title;
}

async function commitRename() {
	const id = renamingId;
	const title = renameText.trim();
	renamingId = null;
	if (!id || title.length === 0) return;
	try {
		await safeInvoke("rename_review", { path: repoPath, reviewId: id, title });
	} catch (e) {
		showToast(errorMessage(e, "Failed to rename review"), "error");
	}
}

// Deleting a review is destructive in every state, so it takes the same
// two-step confirm the publish button uses rather than a single click.
let deleteConfirmingId = $state<string | null>(null);
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

async function onDeleteReviewClick(id: string) {
	if (deleteConfirmingId !== id) {
		if (deleteTimer !== null) clearTimeout(deleteTimer);
		deleteConfirmingId = id;
		deleteTimer = setTimeout(() => {
			deleteConfirmingId = null;
			deleteTimer = null;
		}, 3000);
		return;
	}
	if (deleteTimer !== null) {
		clearTimeout(deleteTimer);
		deleteTimer = null;
	}
	deleteConfirmingId = null;
	try {
		await safeInvoke("delete_review", { path: repoPath, reviewId: id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to delete review"), "error");
	}
}

const REVIEW_STATE_LABEL: Record<string, string> = {
	composing: "composing",
	ready: "ready",
	settled: "settled",
};

// The owner only refreshes on reviews-changed, but list_session_commits takes
// its group headers from the graph cache, so a commit or amend changes its
// answer without emitting one. This panel is destroyed on every jump into a
// diff, so coming back is the moment to re-ask.
// untrack: refresh() writes the very state the panel renders, so a plain call
// would make this effect depend on its own writes and loop. The repo is its
// only dependency.
$effect(() => {
	void repoPath;
	untrack(() => reviewComments.refresh());
});

// Re-resolve whenever the owner lands a refresh. A counter, not the comments
// array: array identity happens to change on every refresh today, but nothing
// pins that, and a deep-equal skip there would silently freeze orphan badges.
$effect(() => {
	void reviewComments.revision;
	loadResolutions();
});

$effect(() => {
	void reviewComments.revision;
	const failure = reviewComments.lastError;
	if (failure === null) return;
	reportReadFailure(failure);
});

// Phase 73-02 — Timer cleanup on component destroy (RESEARCH Pitfall 3). If
// the panel unmounts mid-confirm (e.g. tab close, repo switch), the pending
// setTimeout would otherwise fire `endConfirming = false` against a torn-down
// component and Svelte logs an error. This effect's sole purpose is the
// teardown return — no reactive body.
$effect(() => {
	return () => {
		if (endTimer !== null) clearTimeout(endTimer);
		if (deleteTimer !== null) clearTimeout(deleteTimer);
	};
});
</script>

<div class="flex flex-col" style="flex: 1; min-height: 0; overflow: hidden;">
  <!-- Panel-level header (Phase 72): hosts the Copy button. Disabled until the
       session has >=1 comment; the disabled tooltip and the hard backstop in
       commands/review.rs (no_comments TrunkError) form the gate. The header
       sits above the scrollable list body so the button is always visible
       while the list scrolls. -->
  <div
    class="flex items-center"
    style="
      gap: var(--space-2);
      height: var(--bar-h);
      padding: 0 var(--space-3);
      background: var(--color-surface);
      box-shadow: inset 0 -1px 0 var(--color-border);
      flex-shrink: 0;
      font-size: 12px;
    "
  >
    <span class="preview-spacer" style="flex: 1;"></span>
    {#if activeReview && !activeReview.published}
      <button
        type="button"
        class="publish-button {endConfirming ? 'confirming' : ''} flex items-center"
        onclick={onEndClick}
        disabled={!hasAnyComment}
        title={hasAnyComment
          ? endConfirming
            ? ""
            : "Publish this review so an agent can read it. Nothing is deleted."
          : "A review needs at least one comment before it can be published"}
      >
        <Check size={14} />
        <span>{endConfirming ? "Click again to confirm" : "End review"}</span>
      </button>
    {/if}
    <button
      type="button"
      class="copy-button flex items-center"
      onclick={onCopyClick}
      disabled={!hasAnyComment}
      title={hasAnyComment ? "" : "Add at least one comment to generate"}
    >
      {#if copied}
        <span aria-hidden="true">✓</span>
        <span>Copied</span>
      {:else}
        <Clipboard size={14} />
        <span>Copy</span>
      {/if}
    </button>
  </div>
  <div
    class="flex flex-col"
    style="
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--space-3);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 12px;
      line-height: 1.5;
    "
  >
  <!-- Review list (criterion 2): every review for this repo with its derived
       state, short id, thread count and an editable title. Selecting one makes
       it active, which is also criterion 3's one-step switch. -->
  <div class="flex flex-col" style="gap: var(--space-1); padding-bottom: var(--space-2);">
    <div class="flex items-center" style="gap: var(--space-2); padding: var(--space-1) 0;">
      <span style="color: var(--color-text-muted); font-size: 11px; flex: 1;">
        {reviews.length} {reviews.length === 1 ? "review" : "reviews"}
      </span>
      <button type="button" class="copy-button" onclick={startNewReview}>
        New review
      </button>
    </div>
    <ul class="flex flex-col" style="gap: var(--space-1); list-style: none; margin: 0; padding: 0;">
      {#each reviews as review (review.id)}
        <li class="review-row {review.id === activeReviewId ? 'active' : ''} flex items-center"
            style="gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius);">
          <span
            aria-hidden="true"
            style="width: 6px; flex-shrink: 0; color: var(--color-accent);"
          >{review.id === activeReviewId ? "\u2022" : ""}</span>
          {#if renamingId === review.id}
            <input
              bind:value={renameText}
              onblur={commitRename}
              onkeydown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") renamingId = null;
              }}
              aria-label="Review title"
              style="
                flex: 1;
                background: var(--color-bg);
                color: var(--color-text);
                border: 1px solid var(--color-border);
                border-radius: var(--radius);
                height: var(--control-sm-h);
                padding: 0 var(--space-1);
                font-size: 12px;
                font-family: inherit;
              "
            />
          {:else}
            <button
              type="button"
              onclick={() => activateReview(review.id)}
              ondblclick={() => openRename(review.id, review.title)}
              title="Click to make active · double-click or F2 to rename"
              onkeydown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  openRename(review.id, review.title);
                }
              }}
              aria-label="Activate review {review.id}"
              aria-current={review.id === activeReviewId ? "true" : undefined}
              class="overflow-hidden text-ellipsis whitespace-nowrap"
              style="
                flex: 1;
                text-align: left;
                background: transparent;
                border: none;
                padding: 0;
                cursor: pointer;
                color: inherit;
                font-size: 12px;
                font-family: inherit;
              "
            >{review.title}</button>
          {/if}
          <button
            type="button"
            onclick={() => openRename(review.id, review.title)}
            aria-label="Rename review {review.id}"
            title="Rename this review"
            class="font-mono"
            style="
              background: transparent;
              border: none;
              padding: 0;
              cursor: pointer;
              color: var(--color-text-muted);
              font-size: 11px;
              font-family: inherit;
              flex-shrink: 0;
            "
          >{review.id}</button>
          <span style="color: var(--color-text-muted); font-size: 11px; flex-shrink: 0;">
            {REVIEW_STATE_LABEL[review.state] ?? review.state} · {review.thread_count}
          </span>
          <button
            type="button"
            class="end-button {deleteConfirmingId === review.id ? 'confirming' : ''}"
            onclick={() => onDeleteReviewClick(review.id)}
            aria-label="Delete review {review.id}"
            title={deleteConfirmingId === review.id
              ? "Click again to delete this review and its comments"
              : "Delete this review"}
            style="flex-shrink: 0; padding: 0 var(--space-2);"
          >
            {deleteConfirmingId === review.id ? "Confirm delete" : "Delete review"}
          </button>
        </li>
      {/each}
    </ul>
  </div>

  {#if activeReview}
    <span style="color: var(--color-text-muted); font-size: 11px; padding: var(--space-1) 0;">
      {comments.length} {comments.length === 1 ? "comment" : "comments"} · {commits.length}
      {commits.length === 1 ? "commit" : "commits"}
    </span>
  {/if}

  <!-- Phase 73-03 — Three-way empty-state branching (D-06). Order is specificity-
       first: cold (no session) → warm-no-commits (existing copy preserved
       verbatim) → warm-with-commits-zero-comments (replaces prior "No comments
       yet." copy). The three branches are mutually exclusive; when the user has
       added at least one comment, none render and the list below takes over. -->
  {#if reviews.length === 0}
    <div class="flex flex-col" style="gap: var(--space-1); padding: var(--space-3);">
      <span>No reviews yet</span>
      <span style="color: var(--color-text-muted); font-size: 11px;">
        Comment on a diff line to start one, or create an empty review above.
      </span>
    </div>
  {:else if commits.length === 0 && !hasAnyComment}
    <div class="flex flex-col" style="gap: var(--space-1); padding: var(--space-3);">
      <span>No commits in this review yet.</span>
      <span style="color: var(--color-text-muted); font-size: 11px;">
        Add commits from the graph to start reviewing.
      </span>
    </div>
  {:else if !hasAnyComment}
    <div class="flex flex-col" style="gap: var(--space-1); padding: var(--space-3);">
      <span>Review started.</span>
      <span style="color: var(--color-text-muted); font-size: 11px;">
        Select diff lines or add a commit note to comment.
      </span>
    </div>
  {/if}

  {#if groups.length > 0}
    <ul class="flex flex-col" style="gap: var(--space-2); list-style: none; margin: 0; padding: 0;">
      {#each groups as group (group.oid)}
        <li class="flex flex-col" style="gap: var(--space-1);">
          <!-- Commit group header (focal point): short SHA mono 600 + summary -->
          <div
            class="flex items-center"
            style="gap: var(--space-2); padding: var(--space-1) 0; border-bottom: 1px solid var(--color-border);"
          >
            <button
              type="button"
              title="Copy SHA"
              aria-label="Copy SHA {group.shortOid}"
              onclick={() => copySha(group.oid)}
              class="jump-ref font-mono"
              style="
                background: transparent;
                border: none;
                padding: 0;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                color: inherit;
                font-family: inherit;
                flex-shrink: 0;
              "
            >{group.shortOid}</button>
            <button
              type="button"
              aria-label="Jump to commit {group.shortOid}"
              onclick={() => onJumpToCommit(group.oid)}
              class="jump-ref overflow-hidden text-ellipsis whitespace-nowrap"
              style="
                background: transparent;
                border: none;
                padding: 0;
                cursor: pointer;
                text-align: left;
                font-size: 13px;
                font-weight: 600;
                color: inherit;
                font-family: inherit;
                flex: 1;
              "
            >{group.summary}</button>
            <button
              type="button"
              class="flex items-center"
              onclick={() => openAddNote(group.oid)}
              style="
                gap: var(--space-1);
                background: transparent;
                color: var(--color-text-muted);
                border: none;
                border-radius: var(--radius);
                cursor: pointer;
                padding: var(--space-1);
                flex-shrink: 0;
                font-size: 12px;
              "
              onmouseenter={(e) => (e.currentTarget.style.background = "var(--color-hover)")}
              onmouseleave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <MessageSquarePlus size={14} />
              <span>Add note</span>
            </button>
          </div>

          <!-- Inline add-note composer for this commit -->
          {#if addNoteForCommit === group.oid}
            <div class="flex flex-col" style="gap: var(--space-1); padding: var(--space-1) 0;">
              <textarea
                bind:value={draft.text}
                rows="3"
                style="
                  width: 100%;
                  resize: vertical;
                  background: var(--color-bg);
                  color: var(--color-text);
                  border: 1px solid var(--color-border);
                  border-radius: var(--radius);
                  padding: var(--space-1) var(--space-2);
                  font-size: 12px;
                  font-family: inherit;
                "
              ></textarea>
              <div class="flex items-center" style="gap: var(--space-1);">
                <button
                  type="button"
                  onclick={() => saveAddNote(group.oid)}
                  disabled={!draft.valid}
                  style="
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                    color: var(--color-text);
                    border: 1px solid var(--color-border);
                    border-radius: var(--radius);
                    cursor: pointer;
                    height: var(--control-sm-h);
                    padding: 0 var(--space-2);
                    font-size: 12px;
                  "
                >Save</button>
                <button
                  type="button"
                  onclick={cancelComposer}
                  style="
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                    color: var(--color-text-muted);
                    border: 1px solid var(--color-border);
                    border-radius: var(--radius);
                    cursor: pointer;
                    height: var(--control-sm-h);
                    padding: 0 var(--space-2);
                    font-size: 12px;
                  "
                >Cancel</button>
              </div>
            </div>
          {/if}

          {#if group.comments.length === 0}
            <span style="color: var(--color-text-muted); font-size: 11px; padding: var(--space-1) 0;">
              No comments on this commit.
            </span>
          {:else}
            <ul class="flex flex-col" style="gap: var(--space-1); list-style: none; margin: 0; padding: 0;">
              {#each group.comments as comment (comment.id)}
                <li>
                  <ThreadCard
                    thread={comment}
                    onedit={(id, text) => saveEdit(id, text)}
                    ondelete={(id) => deleteComment(id)}
                    onreplyadd={(id, text) => addReply(repoPath, id, text)}
                    onstatechange={(id, next) => setThreadState(repoPath, id, next)}
                    onreplyedit={(id, text) => editReply(repoPath, id, text)}
                    onreplydelete={(id) => deleteReply(repoPath, id)}
                    confirmDelete={true}
                    variant="panel"
                    onjump={onJump}
                    jumpable={isJumpable(comment)}
                    orphaned={isOrphan(comment)}
                    orphanLabel={orphanLabel(comment)}
                  />
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  </div>
</div>

<style>
  .jump-ref:hover,
  .jump-ref:focus-visible {
    color: var(--color-accent);
    text-decoration: underline;
  }

  /* Phase 72 Copy button — lives in the panel header. Carry-forward from the
     deleted Phase 71 preview component. */
  .copy-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    font-size: 12px;
    font-family: inherit;
  }
  .copy-button:hover:not([disabled]),
  .copy-button:focus-visible:not([disabled]) {
    color: var(--color-text);
    background: var(--color-hover);
  }
  .copy-button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Publish button. Deliberately NOT danger-tinted: ending a review deletes
     nothing, so the icon and colour must not say otherwise. The confirming
     state uses the accent, which reads as "commit to this" rather than
     "destroy this". All colours via :root tokens in src/app.css. */
  .publish-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    font-size: 12px;
    font-family: inherit;
  }
  .publish-button:hover:not(.confirming):not([disabled]),
  .publish-button:focus-visible:not(.confirming):not([disabled]) {
    color: var(--color-text);
    background: var(--color-hover);
  }
  .publish-button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .publish-button.confirming {
    color: var(--fg-1);
    background: var(--color-accent-bg);
    border: 1px solid var(--color-accent);
  }

  /* Delete-review button — genuinely destructive, so it keeps the danger tint. */
  .end-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    font-size: 12px;
    font-family: inherit;
  }
  .end-button:hover:not(.confirming):not([disabled]),
  .end-button:focus-visible:not(.confirming):not([disabled]) {
    color: var(--color-text);
    background: var(--color-hover);
  }
  .end-button.confirming {
    color: var(--fg-1);
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
  }
  .end-button.confirming:hover,
  .end-button.confirming:focus-visible {
    background: var(--color-danger-bg-strong);
    border: 1px solid var(--color-danger);
  }

  .review-row:hover {
    background: var(--color-hover);
  }
  .review-row.active {
    background: var(--color-selected);
  }
</style>
