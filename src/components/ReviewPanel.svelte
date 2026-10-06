<script lang="ts">
// Renders the accumulated review grouped by commit (D-09), with a per-commit
// "Add note" affordance (D-02), inline edit (D-10), delete-with-confirm (D-05),
// and jump-to-anchor with read-only orphan rows (D-07 / D-08). The panel lives
// in the center pane (UI-SPEC:133); jump is driven by the host via onJump.

import Clipboard from "@lucide/svelte/icons/clipboard";
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import Pencil from "@lucide/svelte/icons/pencil";
import Plus from "@lucide/svelte/icons/plus";
import Send from "@lucide/svelte/icons/send";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { untrack } from "svelte";
import { commitOidForComment } from "../lib/comment-counts.js";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import {
	createReviewEditorStore,
	type ReviewNoteEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import { filterThreads, threadMatchesFilter } from "../lib/review-filter.js";
import type { ReviewSessionManager } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommentResolution,
	OrphanReason,
	Review,
	ReviewFilter,
	Thread,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Radio from "../lib/ui/Radio.svelte";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import CommitChip from "./CommitChip.svelte";
import StateGlyph from "./review/StateGlyph.svelte";
import StatePill, { THREAD_LABELS } from "./review/StatePill.svelte";
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
	// Open the file finder. One suppressible affordance rather than several, so
	// milestone 5's hide-all has a single thing to hide.
	oncommentonfile?: () => void;
	reviewFilter?: ReviewFilter;
	// Pressing a state's count in the header asks the owner of the filter, the
	// toolbar's selector, to show only that state, or every thread again.
	onreviewfilterchange?: (filter: ReviewFilter) => void;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	editorNoteSessionFor?: (
		reviewId: string | null,
		surface: string,
	) => ReviewNoteEditorSession;
}

let {
	repoPath,
	session,
	reviewComments,
	onJump,
	onJumpToCommit,
	oncommentonfile,
	reviewFilter = "all",
	onreviewfilterchange,
	editorSessionForThread,
	editorNoteSessionFor,
}: Props = $props();

const commits = $derived(reviewComments.shownCommits);
const comments = $derived(reviewComments.shownThreads);
const visibleComments = $derived(filterThreads(comments, reviewFilter));

// The header's tally, one count per state a thread can be filtered to, in the
// toolbar selector's order.
const STATE_TALLY = [
	{ value: "open", tone: "text-thread-open" },
	{ value: "addressed", tone: "text-thread-addressed" },
	{ value: "done", tone: "text-thread-done" },
	{ value: "dismissed", tone: "text-thread-dismissed" },
	{ value: "stale", tone: "text-thread-stale" },
] as const;

const reviews = $derived(reviewComments.reviews);
const activeReviewId = $derived(reviewComments.activeReviewId);
// The review the panel shows, which is the active one until the user picks
// another from the list. Picking one never moves where new comments land.
const shownReviewId = $derived(reviewComments.shownReviewId);
const shownReview = $derived(reviewComments.shownReview);
const unresolvedCount = $derived(
	comments.filter((t) => t.state === "open" || t.state === "addressed").length,
);

// Orphan resolution stays here: resolve_threads walks a blob per
// comment, and only this panel renders the badge it feeds.
let resolutions = $state<CommentResolution[]>([]);

// Inline add-note composer state. The per-comment edit flow now lives inside
// ThreadCard; the panel only drives the per-commit "Add note" composer. Its
// target and draft live in the review-tab editor store so a panel remount does
// not move text to a different commit or clear it.
const localEditorStore = createReviewEditorStore();
const localNoteSession = localEditorStore.note(null, "review-note");
let noteSession = $state<ReviewNoteEditorSession>(localNoteSession);
const noteDraft = $derived(noteSession.draft);
const noteSaving = $derived(noteSession.saving);

$effect(() => {
	noteSession =
		editorNoteSessionFor?.(activeReviewId, "review-note") ?? localNoteSession;
});

// LOCKED OrphanReason → badge label map (UI-SPEC § Copywriting Contract).
const ORPHAN_LABEL: Record<OrphanReason, string> = {
	CommitGone: "commit gone",
	FileGone: "file gone",
	LineOutOfRange: "line out of range",
	ContentGone: "code gone",
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
		// A current-file comment names no commit, so grouping it by oid puts it
		// in a headerless group keyed by the empty string, whose "Add note"
		// button then writes a commit thread with an empty oid. It gets its own
		// section instead.
		if (c.content_pin) continue;

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

// Comments on a file's own content, which belong to no commit. They render in
// their own section rather than a commit group, and are sorted by file so a
// reader scans one file's comments together.
const currentFileComments = $derived(
	comments
		.filter((c) => c.content_pin)
		.sort((a, b) => {
			const byPath = (a.content_pin?.file_path ?? "").localeCompare(
				b.content_pin?.file_path ?? "",
			);
			if (byPath !== 0) return byPath;
			return (
				(a.content_pin?.start_line ?? 0) - (b.content_pin?.start_line ?? 0)
			);
		}),
);

const hasAnyComment = $derived(comments.length > 0);
const hasVisibleComment = $derived(visibleComments.length > 0);

let endPopoverOpen = $state(false);
let endAnchor = $state<HTMLElement>();

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

// resolve_threads answers for the shown review, or with an empty list when the
// repo has none — a normal state, not a failure.
async function loadResolutions(reviewId: string | null) {
	const seq = ++loadSeq;
	try {
		const next = await safeInvoke<CommentResolution[]>("resolve_threads", {
			path: repoPath,
			reviewId,
		});
		if (seq !== loadSeq) return;
		resolutions = next;
	} catch (e) {
		if (seq !== loadSeq) return;
		reportReadFailure(e);
	}
}

function openAddNote(oid: string) {
	if (noteSaving) return;
	noteSession.open(oid);
}

function cancelComposer() {
	if (noteSaving) return;
	noteSession.close();
}

async function saveAddNote(oid: string) {
	const submittedSession = noteSession;
	const submittedTarget = submittedSession.target;
	const submittedDraft = submittedSession.draft;
	if (
		submittedTarget !== oid ||
		!submittedDraft.valid ||
		submittedSession.saving
	)
		return;

	const text = submittedDraft.text;
	const submittedRevision = submittedDraft.revision;
	submittedSession.setSaving(true);
	try {
		await safeInvoke("add_commit_thread", {
			path: repoPath,
			commitOid: submittedTarget,
			text,
		});
		if (
			submittedSession.target === submittedTarget &&
			submittedDraft.revision === submittedRevision
		) {
			submittedSession.close();
		}
	} catch (e) {
		showToast(errorMessage(e, "Failed to add note"), "error");
	} finally {
		submittedSession.setSaving(false);
	}
}

async function saveEdit(id: string, text: string) {
	try {
		await safeInvoke("edit_thread", { path: repoPath, id, text });
	} catch (e) {
		showToast(errorMessage(e, "Failed to edit comment"), "error");
	}
}

// The button is disabled while nothing is unresolved, so the no_comments
// TrunkError from session.generate is reachable only by a race (another window
// emptied the review between render and click), and it lands in the same toast
// as a clipboard failure.
async function onCopyClick() {
	if (!shownReviewId) return;
	const reviewId = shownReviewId;
	const unresolved = unresolvedCount;

	try {
		const md = await session.generate(repoPath, reviewId);
		await writeText(md);
		showToast(
			`Copied ${unresolved} unresolved ${unresolved === 1 ? "thread" : "threads"} from ${reviewId} as an agent prompt`,
			"success",
		);
	} catch (e) {
		showToast(`Failed to copy: ${errorMessage(e, "unknown error")}`, "error");
	}
}

// Publishing deletes nothing: the review stays listed, its threads stay
// visible, and the snapshot keepalive refs stay. The owner's reviews-changed
// refresh re-reads the now-published review and the button's gate hides it.
async function publishShown() {
	endPopoverOpen = false;
	if (!shownReviewId) return;
	const reviewId = shownReviewId;

	try {
		await safeInvoke("publish_review", { path: repoPath, reviewId });
		showToast(`${reviewId} published`, "success");
	} catch (e) {
		showToast(
			`Failed to publish review: ${errorMessage(e, "unknown error")}`,
			"error",
		);
	}
}

function dismissEndPopover(event: PointerEvent) {
	if (!endPopoverOpen) return;
	if (event.target instanceof Node && endAnchor?.contains(event.target)) return;
	endPopoverOpen = false;
}

async function deleteComment(id: string) {
	try {
		await safeInvoke("delete_thread", { path: repoPath, id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to delete comment"), "error");
	}
}

// ── Review list: show, activate, rename, delete ──────────────────────────────

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
		const id = await safeInvoke<string>("create_review", {
			path: repoPath,
			title: null,
		});
		await reviewComments.select(id);
	} catch (e) {
		showToast(errorMessage(e, "Failed to create review"), "error");
	}
}

// One title is edited at a time, in the list or in the header.
let renaming = $state<{ id: string; where: "list" | "header" } | null>(null);
let renameText = $state("");

function openRename(id: string, title: string, where: "list" | "header") {
	renaming = { id, where };
	renameText = title;
}

function renameKeys(event: KeyboardEvent) {
	if (event.key === "Enter") commitRename();
	if (event.key === "Escape") renaming = null;
}

async function commitRename() {
	const id = renaming?.id;
	const title = renameText.trim();
	renaming = null;
	if (!id || title.length === 0) return;
	try {
		await safeInvoke("rename_review", { path: repoPath, reviewId: id, title });
	} catch (e) {
		showToast(errorMessage(e, "Failed to rename review"), "error");
	}
}

let deleteConfirmingId = $state<string | null>(null);

async function deleteReview(id: string) {
	deleteConfirmingId = null;
	try {
		await safeInvoke("delete_review", { path: repoPath, reviewId: id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to delete review"), "error");
	}
}

function deletePrompt(review: Review): string {
	const threads =
		review.thread_count === 0
			? ""
			: ` and its ${review.thread_count} ${review.thread_count === 1 ? "thread" : "threads"}`;
	const agent = review.published ? " The agent loses access to it." : "";
	return `${threads}?${agent} This can\u2019t be undone.`;
}

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
	loadResolutions(shownReviewId);
});

// Keyed on the failure, NOT on revision: a refused store fails every read and
// the store poll refreshes on every change, so a revision-keyed toast stacked
// one identical copy per refresh until they covered the panel. A failure is a
// condition, so it is announced when it arrives and when it returns after a
// clean refresh — not once per attempt to read through it.
let toastedError: string | null = null;
$effect(() => {
	const failure = reviewComments.lastError;
	if (failure === toastedError) return;
	toastedError = failure;
	if (failure === null) return;
	reportReadFailure(failure);
});
</script>

<svelte:window onpointerdown={dismissEndPopover} />

<div class="review-layout flex-1 min-h-0 overflow-hidden bg-surface">
	<!-- The repo's reviews, one row each. Pressing a row shows that review; the
	     radio beside it makes it the active one, where new comments land. -->
	<nav
		aria-label="Reviews"
		class="flex flex-col min-h-0 border-r border-border text-callout"
	>
		<div class="flex items-center gap-2 h-bar shrink-0 pl-3 pr-1">
			<h2
				class="flex-1 m-0 text-caption font-semibold uppercase text-text-muted"
			>
				Reviews <span class="font-regular">{reviews.length}</span>
			</h2>
			<Button
				size="sm"
				variant="ghost"
				onclick={startNewReview}
				aria-label="New review"
				title="New review (becomes active)"
			>
				<Plus size={12} />
				<span>New</span>
			</Button>
		</div>
		<ul
			class="flex flex-col flex-1 min-h-0 overflow-auto list-none m-0 py-1 px-0"
		>
			{#each reviews as review (review.id)}
				{@const isActive = review.id === activeReviewId}
				{@const isShown = review.id === shownReviewId}
				<li class="review-item" class:review-item-shown={isShown}>
					<span class="review-item-radio">
						<Radio
							checked={isActive}
							aria-label="Active review {review.id}"
							title={isActive ? "Active: new comments land here" : "Make active"}
							onclick={() => activateReview(review.id)}
						/>
					</span>
					{#if renaming?.where === "list" && renaming.id === review.id}
						<div class="py-1 pr-2">
							<input
								bind:value={renameText}
								onblur={commitRename}
								onkeydown={renameKeys}
								aria-label="Review title"
								class="w-full bg-bg text-text border border-accent rounded h-control-sm py-0 px-1 text-callout"
							>
						</div>
					{:else}
						<Row
							variant="entry"
							reveal="fade"
							onclick={() => reviewComments.select(review.id)}
							ondblclick={() => openRename(review.id, review.title, "list")}
							onkeydown={(e) => {
								if (e.key === "F2") {
									e.preventDefault();
									openRename(review.id, review.title, "list");
								}
							}}
							title="Click to show · double-click or F2 to rename"
							aria-label="Show review {review.id}"
							aria-current={isShown ? "true" : undefined}
						>
							<span class="flex flex-col gap-1 min-w-0 w-full">
								<span
									class="min-w-0 font-medium text-text-strong leading-tight line-clamp-2 whitespace-normal"
									>{review.title}</span
								>
								<span
									class="flex items-center gap-2 min-w-0 font-mono text-caption text-text-subtle"
								>
									<span>{review.id}</span>
									<StatePill state={review.state} />
									<span class="flex-1"></span>
									<span
										title="{review.unresolved_count} unresolved of {review.thread_count}"
										>{review.unresolved_count > 0
											? `${review.unresolved_count}/${review.thread_count}`
											: review.thread_count}</span
									>
								</span>
							</span>
							{#snippet actions()}
								<RowAction
									onclick={() => openRename(review.id, review.title, "list")}
									aria-label="Rename review {review.id}"
									title="Rename"
								>
									<Pencil size={12} />
								</RowAction>
								<RowAction
									tone="danger"
									onclick={() => {
										deleteConfirmingId = review.id;
									}}
									aria-label="Delete review {review.id}"
									title="Delete review"
								>
									<Trash2 size={12} />
								</RowAction>
							{/snippet}
						</Row>
					{/if}
					{#if deleteConfirmingId === review.id}
						<fieldset
							aria-label="Delete {review.title}?"
							class="review-confirm flex flex-col gap-2 m-0 p-2 rounded text-small leading-normal text-text"
						>
							<p class="m-0">
								Delete
								<b class="font-semibold text-text-strong">{review.title}</b>
								{deletePrompt(review)}
							</p>
							<div class="flex justify-end gap-2">
								<Button
									size="sm"
									variant="ghost"
									onclick={() => {
										deleteConfirmingId = null;
									}}
									>Cancel</Button
								>
								<Button
									size="sm"
									variant="danger"
									onclick={() => deleteReview(review.id)}
									>Delete review</Button
								>
							</div>
						</fieldset>
					{/if}
				</li>
			{/each}
		</ul>
		<p
			class="flex items-center gap-2 shrink-0 m-0 py-2 px-3 shadow-hairline text-small text-text-subtle"
		>
			<Radio variant="mark" checked />
			Active review. New comments land here.
		</p>
	</nav>

	<section
		aria-label="Review threads"
		class="flex flex-col min-h-0 overflow-hidden"
	>
		<!-- The shown review's name, id and state over its actions, and under them
		     whether it is the active one, whether the agent can see it, and a tally
		     of its threads by state. The header stays put while the list scrolls. -->
		<header class="flex flex-col gap-2 py-3 px-4 shadow-hairline shrink-0">
			<div class="flex items-center gap-2 min-w-0">
				{#if shownReview}
					{#if renaming?.where === "header" && renaming.id === shownReview.id}
						<input
							bind:value={renameText}
							onblur={commitRename}
							onkeydown={renameKeys}
							aria-label="Review title"
							class="review-title-field bg-bg text-text-strong border border-accent rounded h-control py-0 px-1 text-title font-semibold"
						>
					{:else}
						<h1
							class="m-0 min-w-0 truncate text-title font-semibold text-text-strong"
						>
							<LinkButton
								truncate
								title="Click to rename"
								onclick={() =>
									openRename(shownReview.id, shownReview.title, "header")}
								>{shownReview.title}</LinkButton
							>
						</h1>
					{/if}
					<span class="shrink-0 font-mono text-caption text-text-muted"
						>{shownReview.id}</span
					>
					<StatePill state={shownReview.state} />
				{/if}
				<span class="flex-1"></span>
				{#if oncommentonfile && reviewFilter !== "none"}
					<Button
						size="sm"
						onclick={oncommentonfile}
						title="Comment on any tracked file, including one no change touches"
					>
						<MessageSquarePlus size={12} />
						<span>Comment on a file…</span>
					</Button>
				{/if}
				<Button
					size="sm"
					onclick={onCopyClick}
					disabled={unresolvedCount === 0}
					title={unresolvedCount === 0
						? "No unresolved threads to copy"
						: "Copy unresolved threads as a prompt for an agent"}
				>
					<Clipboard size={12} />
					<span>Copy</span>
				</Button>
				{#if shownReview && !shownReview.published}
					<div class="relative" bind:this={endAnchor}>
						<Button
							size="sm"
							variant="primary"
							disabled={!hasAnyComment}
							title={hasAnyComment
								? "Publish to the agent"
								: "Add at least one thread first"}
							onclick={() => {
								endPopoverOpen = !endPopoverOpen;
							}}
						>
							<Send size={12} />
							<span>End review</span>
						</Button>
						{#if endPopoverOpen}
							<div class="end-popover">
								<Dialog
									variant="anchored"
									title="Publish {shownReview.id}?"
									onkeydown={(e) => {
										if (e.key === "Escape") endPopoverOpen = false;
									}}
								>
									<p class="m-0 text-callout leading-normal text-text-muted">
										The agent will be able to read and reply to
										{comments.length}
										{comments.length === 1 ? "thread" : "threads"}. You can keep
										adding comments. Nothing is deleted.
									</p>
									<div class="flex justify-end gap-2">
										<Button
											size="sm"
											variant="ghost"
											onclick={() => {
												endPopoverOpen = false;
											}}
											>Cancel</Button
										>
										<Button size="sm" variant="primary" onclick={publishShown}
											>End review</Button
										>
									</div>
								</Dialog>
							</div>
						{/if}
					</div>
				{/if}
			</div>
			{#if shownReview}
				<div
					class="flex items-center gap-2 min-w-0 whitespace-nowrap text-small text-text-subtle"
				>
					{#if shownReview.id === activeReviewId}
						<span
							class="inline-flex items-center gap-1 font-medium text-accent-strong"
						>
							<Radio variant="mark" checked />
							Active
						</span>
					{:else}
						<LinkButton
							tone="muted"
							onclick={() => activateReview(shownReview.id)}
							>Make active</LinkButton
						>
					{/if}
					<span class="text-text-disabled" aria-hidden="true">·</span>
					<span
						>{shownReview.published
							? "Published"
							: "Not visible to the agent"}</span
					>
					<span class="text-text-disabled" aria-hidden="true">·</span>
					<ul
						aria-label="Threads by state"
						class="flex gap-3 list-none m-0 p-0"
					>
						{#each STATE_TALLY as tally (tally.value)}
							{@const count = comments.filter((t) =>
								threadMatchesFilter(t, tally.value),
							).length}
							{#if count > 0}
								<li
									title={THREAD_LABELS[tally.value]}
									class="inline-flex items-center gap-1 font-mono text-text-muted"
								>
									<span class="inline-flex {tally.tone}" aria-hidden="true">
										<StateGlyph state={tally.value} size={11} />
									</span>
									{count}
								</li>
							{/if}
						{/each}
					</ul>
					{#if reviewFilter !== "all" && reviewFilter !== "none" && hasAnyComment}
						<span class="flex-1"></span>
						<span class="text-accent-strong"
							>Showing {THREAD_LABELS[reviewFilter].toLowerCase()} only ·
							{visibleComments.length}
							of {comments.length}</span
						>
						<LinkButton
							tone="muted"
							onclick={() => onreviewfilterchange?.("all")}
							>Show all</LinkButton
						>
					{/if}
				</div>
			{/if}
		</header>
		<div
			class="flex flex-col flex-1 min-h-0 overflow-auto p-3 bg-surface text-text text-callout leading-normal"
		>
			<!-- Phase 73-03 — Three-way empty-state branching (D-06). Order is specificity-
       first: cold (no session) → warm-no-commits (existing copy preserved
       verbatim) → warm-with-commits-zero-comments (replaces prior "No comments
       yet." copy). The three branches are mutually exclusive; when the user has
       added at least one comment, none render and the list below takes over. -->
			{#if reviews.length === 0}
				<div class="flex flex-col gap-1 p-3">
					<span>No reviews yet</span>
					<span class="text-text-muted text-small leading-normal">
						Comment on a diff line to start one, or create an empty review
						above.
					</span>
				</div>
			{:else if commits.length === 0 && !hasAnyComment}
				<div class="flex flex-col gap-1 p-3">
					<span>No commits in this review yet.</span>
					<span class="text-text-muted text-small leading-normal">
						Add commits from the graph to start reviewing.
					</span>
				</div>
			{:else if !hasAnyComment}
				<div class="flex flex-col gap-1 p-3">
					<span>Review started.</span>
					<span class="text-text-muted text-small leading-normal">
						Select diff lines or add a commit note to comment.
					</span>
				</div>
			{:else if !hasVisibleComment}
				<div class="flex flex-col gap-1 p-3">
					<span
						>{reviewFilter === "none" ? "Review threads hidden." : "No threads match this filter."}</span
					>
					<span class="text-text-muted text-small leading-normal">
						The review inventory remains available above.
					</span>
				</div>
			{/if}

			{#if groups.length > 0}
				<ul class="flex flex-col gap-2 list-none m-0 p-0">
					{#each groups as group (group.oid)}
						{@const visibleGroupComments = filterThreads(group.comments, reviewFilter)}
						<li
							aria-label="Commit {group.shortOid}"
							class="flex flex-col gap-1"
							style:display={reviewFilter === 'none' || (reviewFilter !== 'all' && group.comments.length > 0 && visibleGroupComments.length === 0) ? 'none' : 'flex'}
						>
							<!-- The commit the threads under it were left on: its SHA, which
							     copies itself, its summary, which jumps to it in the graph, how
							     many threads it holds, and a note on the commit as a whole. -->
							<div
								class="flex items-center gap-2 h-bar py-0 px-2 rounded bg-surface-raised text-callout"
							>
								<CommitChip oid={group.oid} />
								<span class="min-w-0 flex-1 text-text">
									<LinkButton
										truncate
										aria-label="Jump to commit {group.shortOid}"
										onclick={() => onJumpToCommit(group.oid)}
										>{group.summary}</LinkButton
									>
								</span>
								<span
									class="shrink-0 text-caption text-text-muted"
									title="Threads on this commit"
									>{group.comments.length}</span
								>
								{#if reviewFilter !== "none"}
									<Button
										size="sm"
										variant="ghost"
										onclick={() => openAddNote(group.oid)}
										disabled={noteSaving}
									>
										<MessageSquarePlus size={14} />
										<span>Add note</span>
									</Button>
								{/if}
							</div>

							<!-- Inline add-note composer for this commit -->
							{#if noteSession.target === group.oid}
								<div
									class="flex flex-col gap-1 py-1 px-0"
									style:display={reviewFilter === 'none' ? 'none' : 'flex'}
								>
									<textarea
										bind:value={noteDraft.text}
										rows="3"
										disabled={noteSaving}
										class="w-full resize-y bg-bg text-text border border-border rounded py-1 px-2 text-callout leading-normal"
									></textarea>
									<div class="flex items-center gap-1">
										<Button
											size="sm"
											onclick={() => saveAddNote(group.oid)}
											disabled={!noteDraft.valid || noteSaving}
											>Save</Button
										>
										<Button
											size="sm"
											onclick={cancelComposer}
											disabled={noteSaving}
											>Cancel</Button
										>
									</div>
								</div>
							{/if}

							{#if group.comments.length === 0}
								<span
									class="text-text-muted text-small leading-normal py-1 px-0"
								>
									No comments on this commit.
								</span>
							{:else}
								<ul class="flex flex-col gap-1 list-none m-0 p-0">
									{#each group.comments as comment (comment.id)}
										<li
											style:display={reviewFilter !== "none" && threadMatchesFilter(comment, reviewFilter) ? "list-item" : "none"}
										>
											<ThreadCard
												thread={comment}
												{repoPath}
												onedit={(id, text) => saveEdit(id, text)}
												ondelete={(id) => deleteComment(id)}
												confirmDelete={true}
												variant="panel"
												onjump={onJump}
												jumpable={isJumpable(comment)}
												orphaned={isOrphan(comment)}
												orphanLabel={orphanLabel(comment)}
												{editorSessionForThread}
											/>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if currentFileComments.length > 0}
				{@const visibleCurrentFileComments = filterThreads(currentFileComments, reviewFilter)}
				<div
					class="flex flex-col gap-1"
					style:display={reviewFilter === 'none' || (reviewFilter !== 'all' && visibleCurrentFileComments.length === 0) ? 'none' : 'flex'}
				>
					<div class="text-callout text-text-muted py-0 px-1">
						On current file content
					</div>
					<ul class="flex flex-col gap-1 list-none m-0 p-0">
						{#each currentFileComments as comment (comment.id)}
							<li
								style:display={reviewFilter !== "none" && threadMatchesFilter(comment, reviewFilter) ? "list-item" : "none"}
							>
								<ThreadCard
									thread={comment}
									{repoPath}
									onedit={(id, text) => saveEdit(id, text)}
									ondelete={(id) => deleteComment(id)}
									confirmDelete={true}
									variant="panel"
									onjump={onJump}
									jumpable={false}
									orphaned={isOrphan(comment)}
									orphanLabel={orphanLabel(comment)}
									{editorSessionForThread}
								/>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</section>
</div>

<style>
.review-layout {
	display: grid;
	grid-template-columns: var(--review-list-w) minmax(0, 1fr);
}

/* A review in the list: the radio that makes it active, beside the row that
   shows it, and under both the delete confirmation when it is asked for. */
.review-item {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	align-items: start;
}
.review-item-radio {
	display: flex;
	padding: var(--space-2) 0 0 var(--space-3);
}
.review-item-shown {
	background: var(--color-selected-row);
	box-shadow: inset 2px 0 0 var(--color-accent);
}
.review-confirm {
	grid-column: 1 / -1;
	margin: 0 var(--space-2) var(--space-2) var(--space-3);
	background: var(--color-danger-bg);
	border: 1px solid var(--color-danger-border);
}

.review-title-field {
	width: calc(70 * var(--u));
}

/* The End review popover, under its button and aligned to its trailing edge. */
.end-popover {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	width: calc(80 * var(--u));
	margin-top: var(--space-1);
}
</style>
