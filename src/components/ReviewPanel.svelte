<script lang="ts">
// Renders the shown review grouped by branch, then commit, then file, with a per-commit
// "Add note" affordance (D-02), inline edit (D-10), delete-with-confirm (D-05),
// and jump-to-anchor with read-only orphan rows (D-07 / D-08). The panel lives
// in the center pane (UI-SPEC:133); jump is driven by the host via onJump.

import Clipboard from "@lucide/svelte/icons/clipboard";
import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
import File from "@lucide/svelte/icons/file";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import MessageSquare from "@lucide/svelte/icons/message-square";
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import Plus from "@lucide/svelte/icons/plus";
import Send from "@lucide/svelte/icons/send";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tick, untrack } from "svelte";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import { laneColor } from "../lib/lanes.js";
import { currentMinute } from "../lib/now.svelte.js";
import { exactLabel, relativeLabel } from "../lib/relative-time.js";
import {
	activateReview,
	renameReview,
	startNewReview,
} from "../lib/review-actions.js";
import { setThreadState } from "../lib/review-comment-actions.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import {
	createReviewEditorStore,
	type ReviewNoteEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import { filterThreads, threadMatchesFilter } from "../lib/review-filter.js";
import {
	type ReviewFile,
	type ReviewGroup,
	type ReviewSection,
	reviewSections,
} from "../lib/review-sections.js";
import type { ReviewSessionManager } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommentResolution,
	OrphanReason,
	Review,
	ReviewFilter,
	Thread,
	ThreadState,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Chip from "../lib/ui/Chip.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import Keycap from "../lib/ui/Keycap.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Radio from "../lib/ui/Radio.svelte";
import BranchChip from "./BranchChip.svelte";
import CommitChip from "./CommitChip.svelte";
import ComposerFrame from "./review/ComposerFrame.svelte";
import ReviewEmpty from "./review/ReviewEmpty.svelte";
import StateGlyph from "./review/StateGlyph.svelte";
import StatePill, { THREAD_LABELS } from "./review/StatePill.svelte";
import WaysToComment from "./review/WaysToComment.svelte";
import ThreadCard from "./ThreadCard.svelte";

interface Props {
	repoPath: string;
	// The review-session rune (owned by RepoView, threaded in so the panel can
	// drive panel-internal swaps and call the Phase 70 Generate IPC via the rune).
	session: ReviewSessionManager;
	// The review session itself: lifecycle state, commits and comments. Owned by
	// RepoView, which outlives this panel: leaving review mode destroys it.
	reviewComments: ReviewCommentsManager;
	// Resolvable-comment jump: the host (RepoView) binds this to the review-session
	// rune's jumpTo, wiring commit/file selection + scroll-to-range.
	onJump: (comment: Thread) => void;
	// Commit-header jump: show the commit in the graph, which takes the window
	// out of review mode.
	onJumpToCommit: (commitOid: string) => void;
	// Open the file finder. One suppressible affordance rather than several, so
	// milestone 5's hide-all has a single thing to hide.
	oncommentonfile?: () => void;
	// Open a file's current content, where its current-file threads live.
	onopenfile?: (filePath: string) => void;
	// The checked-out branch, which uncommitted work and current-file threads
	// belong to. Null while HEAD is detached.
	headBranch?: string | null;
	reviewFilter?: ReviewFilter;
	// Pressing a state's count in the header asks the owner of the filter, the
	// toolbar's selector, to show only that state, or every thread again.
	onreviewfilterchange?: (filter: ReviewFilter) => void;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	editorNoteSessionFor?: (
		reviewId: string | null,
		surface: string,
	) => ReviewNoteEditorSession;
	// Every repo tab keeps its panel mounted, so only the shown tab's panel may
	// answer the thread keys the window hears.
	keysActive?: boolean;
	// False while a diff a jump opened covers the panel, which stays mounted
	// underneath so it comes back where it was.
	shown?: boolean;
	// The reviews list in the pane beside the panel. Focus there, left by
	// pressing a review, still leaves the thread keys to the panel.
	reviewList?: HTMLElement | null;
}

let {
	repoPath,
	session,
	reviewComments,
	onJump,
	onJumpToCommit,
	oncommentonfile,
	onopenfile,
	headBranch = null,
	reviewFilter = "all",
	onreviewfilterchange,
	editorSessionForThread,
	editorNoteSessionFor,
	keysActive = true,
	shown = true,
	reviewList = null,
}: Props = $props();

let panelEl = $state<HTMLElement | null>(null);

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

const sections = $derived(
	reviewSections({ threads: comments, commits, headBranch }),
);

function shows(thread: Thread): boolean {
	return reviewFilter !== "none" && threadMatchesFilter(thread, reviewFilter);
}

// A block of threads hides once the filter hides every one of them. A commit
// nobody commented on yet stays, for its Add note.
function hidesAll(threads: Thread[]): boolean {
	if (reviewFilter === "none") return true;
	return reviewFilter !== "all" && threads.length > 0 && !threads.some(shows);
}

function hidesSection(section: ReviewSection): boolean {
	return section.groups.every((group) => hidesAll(group.threads));
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sectionSummary(section: ReviewSection): string {
	const commitCount = section.groups.filter(
		(group) => group.kind === "commit" || group.kind === "gone",
	).length;
	const threadCount = section.groups.reduce(
		(sum, group) => sum + group.threads.length,
		0,
	);
	const threads = plural(threadCount, "thread");
	return commitCount === 0
		? threads
		: `${plural(commitCount, "commit")} · ${threads}`;
}

function sectionLane(section: ReviewSection): string {
	return section.colorIndex === null
		? "var(--color-text-subtle)"
		: laneColor(section.colorIndex);
}

function groupLabel(group: ReviewGroup): string {
	if (group.kind === "current") return "Current file content";
	if (group.kind === "uncommitted") return "Uncommitted changes";
	return `Commit ${group.commit?.short_oid}`;
}

function openFile(group: ReviewGroup, file: ReviewFile) {
	if (group.kind === "current") onopenfile?.(file.path);
	else jump(file.threads[0]);
}

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf("/");
	return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const hasAnyComment = $derived(comments.length > 0);
const hasVisibleComment = $derived(visibleComments.length > 0);
const shownIsActive = $derived(shownReviewId === activeReviewId);

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

// The thread J and K move between, and D, X, O, R and Enter act on.
let focusedId = $state<string | null>(null);
const shownThreads = $derived(
	sections
		.flatMap((section) => section.groups)
		.flatMap((group) => group.threads)
		.filter(shows),
);
let bodyEl = $state<HTMLElement>();

const KEY_LEGEND: [string[], string][] = [
	[["J", "K"], "move"],
	[["↵"], "open code"],
	[["R"], "reply"],
	[["D"], "done"],
	[["X"], "dismiss"],
	[["O"], "reopen"],
];

const STEP_KEYS: Partial<Record<string, ThreadState>> = {
	d: "done",
	x: "dismissed",
	o: "open",
};

function cardOf(id: string): HTMLElement | null {
	return (
		bodyEl?.querySelector<HTMLElement>(
			`[data-thread-id="${CSS.escape(id)}"]`,
		) ?? null
	);
}

function focusThreadAt(index: number) {
	const thread =
		shownThreads[Math.max(0, Math.min(shownThreads.length - 1, index))];
	if (!thread) return;

	focusedId = thread.id;
	void tick().then(() =>
		cardOf(thread.id)?.scrollIntoView({ block: "nearest" }),
	);
}

// The thread a jump to code leaves from is the one to come back to.
function jump(thread: Thread) {
	focusedId = thread.id;
	onJump(thread);
}

// Coming back from the diff puts the keys on the thread the jump left from,
// where its card was, instead of on nothing.
let wasShown = untrack(() => shown);
$effect(() => {
	const returning = shown && !wasShown;
	wasShown = shown;
	if (!returning || focusedId === null) return;

	const id = focusedId;
	void tick().then(() => {
		const card = cardOf(id);
		card?.focus({ preventScroll: true });
		card?.scrollIntoView({ block: "nearest" });
	});
});

// Enter on a focused button presses that button; it is not a request to open code.
function pressesAControl(element: Element | null): boolean {
	return (
		element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement
	);
}

// The keys belong to the panel while nothing else holds focus, or while focus
// sits inside it or the reviews list: a toolbar control or a dialog keeps its
// own keys.
function keysAreOurs(): boolean {
	const focused = document.activeElement;
	if (focused === null || focused === document.body) return true;
	const inReview =
		panelEl?.contains(focused) === true ||
		reviewList?.contains(focused) === true;
	return inReview && !focusInEditable(focused);
}

function threadKeys(event: KeyboardEvent) {
	// A key typed into a field is the field's, wherever focus has since gone.
	const target = event.target instanceof Element ? event.target : null;
	if (!keysActive || !keysAreOurs() || focusInEditable(target)) return;

	const chord = keyChord(event);
	const at = shownThreads.findIndex((thread) => thread.id === focusedId);
	if (chord === "j") {
		focusThreadAt(at + 1);
		return;
	}
	if (chord === "k") {
		focusThreadAt(at - 1);
		return;
	}

	const thread = shownThreads[at];
	if (!thread) return;

	const step = STEP_KEYS[chord];
	if (step !== undefined) {
		if (thread.allowed_transitions.includes(step)) {
			void setThreadState(repoPath, thread.id, step);
		}
		return;
	}
	if (chord === "Enter" && !pressesAControl(document.activeElement)) {
		if (isJumpable(thread)) jump(thread);
		return;
	}
	if (chord === "r") {
		event.preventDefault();
		cardOf(thread.id)
			?.querySelector<HTMLElement>("[aria-label='Reply']")
			?.focus();
	}
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

// One title is edited at a time, in the header.
let renaming = $state<string | null>(null);
let renameText = $state("");

function openRename(review: Review) {
	renaming = review.id;
	renameText = review.title;
}

function renameKeys(event: KeyboardEvent) {
	if (event.key === "Enter") commitRename();
	if (event.key === "Escape") renaming = null;
}

function commitRename() {
	const id = renaming;
	renaming = null;
	if (id) void renameReview(repoPath, id, renameText);
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

<svelte:window onpointerdown={dismissEndPopover} onkeydown={threadKeys} />

<section
	aria-label="Review threads"
	class="flex flex-col flex-1 min-h-0 overflow-hidden bg-surface"
	bind:this={panelEl}
>
	<!-- The shown review's name, id and state over its actions, and under them
	     whether it is the active one, whether the agent can see it, and a tally
	     of its threads by state. The header stays put while the list scrolls. -->
	<header class="flex flex-col gap-2 py-3 px-4 shadow-hairline shrink-0">
		<!-- The actions wrap under a title too long to share the line with them,
		     rather than squeezing it to a few letters. -->
		<div class="flex flex-wrap items-center gap-2 min-w-0">
			<div class="review-title-row flex items-center gap-2 min-w-0">
				{#if shownReview}
					{#if renaming === shownReview.id}
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
								onclick={() => openRename(shownReview)}
								>{shownReview.title}</LinkButton
							>
						</h1>
					{/if}
					<span class="shrink-0 font-mono text-caption text-text-muted"
						>{shownReview.id}</span
					>
					<StatePill state={shownReview.state} />
				{/if}
			</div>
			<div class="flex items-center gap-2 ml-auto">
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
						onclick={() => activateReview(repoPath, shownReview.id)}
						>Make active</LinkButton
					>
				{/if}
				<span class="text-text-disabled" aria-hidden="true">·</span>
				<span
					>{shownReview.published
						? "Published"
						: "Not visible to the agent"}</span
				>
				{#if comments.length > 0}
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
				{/if}
				{#if reviewFilter !== "all" && reviewFilter !== "none" && hasAnyComment}
					<span class="flex-1"></span>
					<span class="text-accent-strong"
						>Showing {THREAD_LABELS[reviewFilter].toLowerCase()} only ·
						{visibleComments.length}
						of {comments.length}</span
					>
					<LinkButton tone="muted" onclick={() => onreviewfilterchange?.("all")}
						>Show all</LinkButton
					>
				{/if}
			</div>
		{/if}
	</header>
	<div
		bind:this={bodyEl}
		class="flex flex-col flex-1 min-h-0 overflow-auto p-3 bg-surface text-text text-callout leading-normal"
	>
		{#if reviews.length === 0}
			<ReviewEmpty title="No reviews in this repository">
				{#snippet icon()}
					<ClipboardCheck size={18} />
				{/snippet}
				<p>
					A review collects comment threads on commits and uncommitted work.
					When you end it, an agent can read the threads through the trunk CLI,
					reply, and claim fixes for you to confirm.
				</p>
				<p>Your first comment starts a review automatically.</p>
				<WaysToComment />
				{#snippet actions()}
					<Button
						variant="primary"
						size="sm"
						onclick={() => startNewReview(repoPath, reviewComments)}
					>
						<Plus size={13} aria-hidden="true" />New review
					</Button>
				{/snippet}
			</ReviewEmpty>
		{:else if !hasAnyComment}
			<ReviewEmpty
				title={shownIsActive
					? "This review is active and empty"
					: "No comments in this review"}
			>
				{#snippet icon()}
					<MessageSquare size={18} />
				{/snippet}
				<p>
					{shownIsActive
						? "New comments you write anywhere in this repo land here."
						: "Make it active to collect new comments here."}
					The agent can’t see the review until you end it, which needs at least
					one thread.
				</p>
				<WaysToComment />
			</ReviewEmpty>
		{:else if reviewFilter === "none"}
			<div class="flex flex-col gap-1 p-3">
				<span>Review threads hidden.</span>
				<span class="text-text-muted text-small leading-normal">
					The review inventory remains available above.
				</span>
			</div>
		{:else if !hasVisibleComment && reviewFilter !== "all"}
			<ReviewEmpty
				title="No {THREAD_LABELS[reviewFilter].toLowerCase()} threads"
			>
				{#snippet icon()}
					<StateGlyph state={reviewFilter} size={18} />
				{/snippet}
				<p>
					None of the {plural(comments.length, "thread")} in this review are
					{THREAD_LABELS[reviewFilter].toLowerCase()}.
				</p>
				{#snippet actions()}
					<Button size="sm" onclick={() => onreviewfilterchange?.("all")}>
						Show all {plural(comments.length, "thread")}
					</Button>
				{/snippet}
			</ReviewEmpty>
		{/if}

		{#each sections as section (section.key)}
			<section
				class="review-branch"
				aria-label={section.branch === null ? "Not on any branch" : `Branch ${section.branch}`}
				style:--lane={sectionLane(section)}
				style:display={hidesSection(section) ? "none" : "block"}
			>
				<header
					class="review-branch-head flex items-center gap-2 h-bar pl-3 pr-4 bg-surface-raised"
				>
					{#if section.branch === null}
						<span class="font-medium text-callout text-text-subtle"
							>Not on any branch</span
						>
					{:else}
						<span class="review-branch-ref flex min-w-0">
							<BranchChip name={section.branch} tone="lane" />
						</span>
						{#if section.isHead}
							<span class="review-meta">checked out</span>
						{/if}
					{/if}
					<span class="flex-1"></span>
					<span class="review-meta">{sectionSummary(section)}</span>
				</header>
				<ul class="list-none m-0 p-0">
					{#each section.groups as group (group.key)}
						<li
							class="review-group"
							aria-label={groupLabel(group)}
							style:display={hidesAll(group.threads) ? "none" : "block"}
						>
							<div
								class="review-group-head flex items-center gap-2 h-bar pl-4 pr-2 bg-surface text-callout text-text"
							>
								<span class="review-node" data-kind={group.kind}></span>
								{#if group.kind === "commit" && group.commit}
									<CommitChip oid={group.commit.oid} />
									<span class="min-w-0 shrink">
										<LinkButton
											truncate
											aria-label="Jump to commit {group.commit.short_oid}"
											onclick={() => group.commit && onJumpToCommit(group.commit.oid)}
											>{group.commit.summary}</LinkButton
										>
									</span>
									{#if group.commit.author_timestamp !== null}
										<span
											class="review-meta"
											title={exactLabel(group.commit.author_timestamp)}
											>{relativeLabel(group.commit.author_timestamp, currentMinute())}</span
										>
									{/if}
								{:else if group.kind === "gone" && group.commit}
									<Chip variant="label" tone="neutral"
										>{group.commit.short_oid}</Chip
									>
									<span class="min-w-0 truncate text-text-subtle"
										>{group.commit.summary}
										· commit no longer exists</span
									>
								{:else if group.kind === "uncommitted"}
									<span class="font-medium text-text-strong"
										>Uncommitted changes</span
									>
								{:else}
									<span class="font-medium text-text-strong"
										>Current file content · HEAD</span
									>
								{/if}
								<span
									class="shrink-0 text-caption text-text-muted"
									title="Threads on this commit"
									>{group.threads.length}</span
								>
								<span class="flex-1"></span>
								{#if group.kind === "commit" && group.commit && reviewFilter !== "none"}
									{@const oid = group.commit.oid}
									<Button
										size="sm"
										variant="ghost"
										onclick={() => openAddNote(oid)}
										disabled={noteSaving}
									>
										<MessageSquarePlus size={14} />
										<span>Add note</span>
									</Button>
								{/if}
							</div>

							<div class="review-group-list flex flex-col gap-2">
								{#if group.commit && noteSession.target === group.commit.oid}
									{@const commit = group.commit}
									<div
										class="flex"
										style:display={reviewFilter === "none" ? "none" : "flex"}
									>
										<ComposerFrame
											activeReview={reviewComments.activeReview}
											{activeReviewId}
											placeholder="Whole-commit note… Markdown supported"
											bind:text={noteDraft.text}
											busy={noteSaving}
											submitLabel="Add note"
											submitDisabled={!noteDraft.valid || noteSaving}
											onsubmit={() => void saveAddNote(commit.oid)}
											oncancel={cancelComposer}
											onescape={cancelComposer}
										>
											{#snippet heading()}
												<GitCommitHorizontal
													size={13}
													class="shrink-0 text-accent"
													aria-hidden="true"
												/>
												Note on {commit.short_oid}
											{/snippet}
										</ComposerFrame>
									</div>
								{/if}

								{#if group.threads.length === 0}
									<span class="text-text-muted text-small leading-normal">
										No comments on this commit.
									</span>
								{/if}

								{#if group.notes.length > 0}
									<ul class="flex flex-col gap-2 list-none m-0 p-0">
										{#each group.notes as comment (comment.id)}
											<li style:display={shows(comment) ? "list-item" : "none"}>
												{@render card(comment)}
											</li>
										{/each}
									</ul>
								{/if}

								{#each group.files as file (file.path)}
									{@const path = splitPath(file.path)}
									<div
										class="flex flex-col gap-2"
										style:display={hidesAll(file.threads) ? "none" : "flex"}
									>
										<div
											class="flex items-center gap-2 min-w-0 h-control-sm text-text-subtle"
										>
											<File size={12} class="shrink-0" aria-hidden="true" />
											<span class="flex min-w-0 text-small">
												<LinkButton
													tone="muted"
													mono
													aria-label="Open {file.path}"
													title={group.kind === "gone" ? "Commit was garbage-collected" : `Open ${file.path}`}
													disabled={group.kind === "gone"}
													onclick={() => openFile(group, file)}
												>
													<span class="flex min-w-0">
														<span class="review-path-dir"
															><bdi>{path.dir}</bdi></span
														>
														<span class="review-path-name">{path.name}</span>
													</span>
												</LinkButton>
											</span>
											<span class="flex-1"></span>
											<span class="review-meta"
												>{plural(file.threads.length, "thread")}</span
											>
										</div>
										<ul class="flex flex-col gap-2 list-none m-0 p-0">
											{#each file.threads as comment (comment.id)}
												<li
													style:display={shows(comment) ? "list-item" : "none"}
												>
													{@render card(comment)}
												</li>
											{/each}
										</ul>
									</div>
								{/each}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
	{#if shownThreads.length > 0}
		<p
			role="note"
			aria-label="Keyboard shortcuts"
			class="review-keys flex items-center gap-1 h-bar px-4 m-0 shrink-0 overflow-hidden whitespace-nowrap text-small text-text-subtle"
		>
			{#each KEY_LEGEND as [keys, meaning] (meaning)}
				{#each keys as key (key)}
					<Keycap>{key}</Keycap>
				{/each}
				<span class="mr-2">{meaning}</span>
			{/each}
		</p>
	{/if}
</section>

{#snippet card(comment: Thread)}
	<ThreadCard
		thread={comment}
		{repoPath}
		onedit={(id, text) => saveEdit(id, text)}
		ondelete={(id) => deleteComment(id)}
		confirmDelete={true}
		variant="panel"
		scoped
		focused={focusedId === comment.id}
		onfocusrequest={() => (focusedId = comment.id)}
		onjump={jump}
		jumpable={isJumpable(comment)}
		orphaned={isOrphan(comment)}
		orphanLabel={orphanLabel(comment)}
		{editorSessionForThread}
	/>
{/snippet}

<style>
/* The title gives way to the actions only down to a readable width, and past
   that the actions wrap onto their own row. */
.review-title-row {
	flex: 1 1 var(--review-title-min);
}

/* A branch's section: its head stays in view while its commits scroll under
   it, and each commit's head stays under that. The rail down the left joins a
   commit's node to the threads under it, in the branch's lane colour. */
.review-branch + .review-branch {
	margin-top: var(--space-3);
}
.review-branch-head {
	position: sticky;
	/* The body's top padding scrolls threads into view above a head stuck at
	   its padding edge, so it sticks at the scrollport's edge instead. */
	top: calc(-1 * var(--space-3));
	z-index: 4;
	border-top: 1px solid var(--color-border);
	box-shadow: var(--shadow-hairline);
}
.review-branch-ref {
	max-width: 60%;
}
.review-keys {
	border-top: 1px solid var(--color-border);
}

.review-meta {
	font-family: var(--font-mono);
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	white-space: nowrap;
}
.review-group {
	position: relative;
}
.review-group::before {
	content: "";
	position: absolute;
	left: calc(var(--space-4) + var(--u));
	top: calc(var(--bar-h) / 2);
	bottom: 0;
	width: calc(var(--u) / 2);
	background: color-mix(in oklch, var(--lane) 55%, transparent);
}
.review-group:last-child::before {
	bottom: var(--space-3);
}
.review-group-head {
	position: sticky;
	top: calc(var(--bar-h) - var(--space-3));
	z-index: 3;
	box-shadow: var(--shadow-hairline);
}
.review-group + .review-group .review-group-head {
	border-top: 1px solid var(--color-border);
}
.review-node {
	position: relative;
	z-index: 1;
	flex-shrink: 0;
	width: calc(5 * var(--u) / 2);
	height: calc(5 * var(--u) / 2);
	border-radius: 50%;
	background: var(--lane);
}
.review-node[data-kind="uncommitted"],
.review-node[data-kind="current"] {
	background: var(--color-surface);
	border: 1px dashed var(--lane);
}
.review-node[data-kind="gone"] {
	background: var(--color-surface);
	border: 1px dashed var(--color-text-subtle);
}
.review-group-list {
	padding: var(--space-2) var(--space-4) var(--space-3)
		calc(var(--space-4) + var(--space-5));
}
.review-path-dir {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	direction: rtl;
	text-align: left;
}
.review-path-name {
	flex-shrink: 0;
	white-space: nowrap;
	color: var(--color-text-strong);
	font-weight: var(--weight-medium);
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
