<script lang="ts">
// Renders the shown review grouped by branch, then commit, then file, with a per-commit
// "Add note" affordance (D-02), inline edit (D-10), delete-with-confirm (D-05),
// and jump-to-anchor with read-only orphan rows (D-07 / D-08). The panel lives
// in the center pane (UI-SPEC:133); jump is driven by the host via onJump.

import Archive from "@lucide/svelte/icons/archive";
import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
import Copy from "@lucide/svelte/icons/copy";
import File from "@lucide/svelte/icons/file";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import MessageSquare from "@lucide/svelte/icons/message-square";
import MessageSquareText from "@lucide/svelte/icons/message-square-text";
import Plus from "@lucide/svelte/icons/plus";
import Send from "@lucide/svelte/icons/send";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tick, untrack } from "svelte";
import { fromAction } from "svelte/attachments";
import { copySha } from "../lib/clipboard.js";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import { laneColor } from "../lib/lanes.js";
import { currentMinute } from "../lib/now.svelte.js";
import { exactLabel, relativeLabel } from "../lib/relative-time.js";
import {
	activateReview,
	archiveReview,
	renameReview,
	startNewReview,
	unarchiveReview,
} from "../lib/review-actions.js";
import { setThreadState } from "../lib/review-comment-actions.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import {
	createReviewEditorStore,
	type ReviewNoteEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import {
	ALL_THREADS,
	filterThreads,
	presetOf,
	THREAD_PRESETS,
	threadMatchesFilter,
	toggleStale,
	toggleState,
} from "../lib/review-filter.js";
import {
	type ReviewFile,
	type ReviewGroup,
	type ReviewSection,
	reviewSections,
} from "../lib/review-sections.js";
import type { ReviewSessionManager } from "../lib/review-session.svelte.js";
import { reviewTitle } from "../lib/review-title.js";
import { selectOnOpen } from "../lib/select-on-open.js";
import { showToast } from "../lib/toast.svelte.js";
import { tooltip } from "../lib/tooltip.js";
import type {
	CommentResolution,
	Delivery,
	OrphanReason,
	Review,
	ReviewFilter,
	Thread,
	ThreadFilter,
	ThreadState,
} from "../lib/types.js";
import Badge from "../lib/ui/Badge.svelte";
import Button from "../lib/ui/Button.svelte";
import ButtonGroup from "../lib/ui/ButtonGroup.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import Keycap from "../lib/ui/Keycap.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Radio from "../lib/ui/Radio.svelte";
import BranchChip from "./BranchChip.svelte";
import ComposerFrame from "./review/ComposerFrame.svelte";
import FoldBar from "./review/FoldBar.svelte";
import ReviewEmpty from "./review/ReviewEmpty.svelte";
import ReviewTitle from "./review/ReviewTitle.svelte";
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
	// The header's presets and its Show all ask the owner of the filter, App,
	// which shares it with the diff and the graph, to show other threads.
	onreviewfilterchange?: (filter: ThreadFilter) => void;
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
	reviewFilter = ALL_THREADS,
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
const hiddenCount = $derived(comments.length - visibleComments.length);
const activePreset = $derived(presetOf(reviewFilter));

// The header's tally, one count per state, and the stale threads among them.
const STATE_TALLY = [
	{ value: "open", tone: "text-thread-open" },
	{ value: "addressed", tone: "text-thread-addressed" },
	{ value: "done", tone: "text-thread-done" },
	{ value: "dismissed", tone: "text-thread-dismissed" },
	{ value: "stale", tone: "text-thread-stale" },
] as const;

const reviews = $derived(reviewComments.reviews);
const activeReviewId = $derived(reviewComments.activeReviewId);
// A note lands in the active review, so the active review's batch decides
// whether it can be sent alone, whichever review the panel shows.
const noteBatchHeld = $derived(
	(reviewComments.activeReview?.pending_count ?? 0) > 0,
);
// The review the panel shows, which is the active one until the user picks
// another from the list. Picking one never moves where new comments land.
const shownReviewId = $derived(reviewComments.shownReviewId);
const shownReview = $derived(reviewComments.shownReview);

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
	return threadMatchesFilter(thread, reviewFilter);
}

// A block of threads hides once the filter hides every one of them. A commit
// nobody commented on yet stays, for its Add note.
function hidesAll(threads: Thread[]): boolean {
	if (reviewFilter === "none") return true;
	return threads.length > 0 && !threads.some(shows);
}

function tallyCount(value: ThreadState | "stale"): number {
	return comments.filter((thread) =>
		value === "stale" ? thread.stale : thread.state === value,
	).length;
}

function tallyOn(value: ThreadState | "stale"): boolean {
	if (reviewFilter === "none") return false;
	if (value === "stale") return reviewFilter.stale;
	return reviewFilter.states.includes(value);
}

function toggleTally(value: ThreadState | "stale") {
	onreviewfilterchange?.(
		value === "stale"
			? toggleStale(reviewFilter)
			: toggleState(reviewFilter, value),
	);
}

function presetCount(states: readonly ThreadState[]): number {
	return comments.filter((thread) => states.includes(thread.state)).length;
}

function showAll() {
	onreviewfilterchange?.(ALL_THREADS);
}

function hidesSection(section: ReviewSection): boolean {
	return section.groups.every((group) => hidesAll(group.threads));
}

// A commit or a file whose threads are all settled when it first shows starts
// folded, and one the reader settles stays open under them. A thread reopened
// there, or a new one, unfolds it, and a press on its bar holds only until
// such a change. A file's key is its group's key and its path, since one path
// can sit under several commits.
let folds = $state<Record<string, { settled: boolean; collapsed: boolean }>>(
	{},
);
// Not state: it is written while the bars render, and only ever once a key.
const settledAtFirstSight = new Map<string, boolean>();

function fileKey(group: ReviewGroup, file: ReviewFile): string {
	return `${group.key}:${file.path}`;
}

function allSettled(threads: Thread[]): boolean {
	return (
		threads.length > 0 &&
		threads.every((t) => t.state === "done" || t.state === "dismissed")
	);
}

function isFolded(key: string, threads: Thread[]): boolean {
	const fold = folds[key];
	const settled = allSettled(threads);
	if (fold !== undefined && fold.settled === settled) return fold.collapsed;

	const sighting = `${shownReviewId}:${key}`;
	if (!settledAtFirstSight.has(sighting))
		settledAtFirstSight.set(sighting, settled);
	return settled && settledAtFirstSight.get(sighting) === true;
}

function toggleFold(key: string, threads: Thread[]) {
	folds[key] = {
		settled: allSettled(threads),
		collapsed: !isFolded(key, threads),
	};
}

function foldedAway(group: ReviewGroup, thread: Thread): boolean {
	if (isFolded(group.key, group.threads)) return true;
	return group.files.some(
		(file) =>
			isFolded(fileKey(group, file), file.threads) &&
			file.threads.includes(thread),
	);
}

const FOLD_NOUNS: Record<ReviewGroup["kind"], string> = {
	commit: "commit",
	gone: "commit",
	uncommitted: "uncommitted changes",
	current: "current file content",
};

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// An archived review stays unseen after its batch is sent, so the promise
// waits on unarchiving it.
function sendSummary(review: Review): string {
	const held = plural(review.pending_count, "held comment");
	const when = review.archived ? " once the review is unarchived" : "";
	return `The agent will be able to read and reply to ${held}${when}. Nothing is deleted.`;
}

function sectionSummary(section: ReviewSection): string {
	const commitCount = section.groups.filter(
		(group) =>
			(group.kind === "commit" || group.kind === "gone") &&
			!hidesAll(group.threads),
	).length;
	const threadCount = section.groups.reduce(
		(sum, group) => sum + shownCount(group.threads),
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

function shownCount(threads: Thread[]): number {
	return filterThreads(threads, reviewFilter).length;
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

let sendPopoverOpen = $state(false);
let sendAnchor = $state<HTMLElement>();

function isOrphan(c: Thread): boolean {
	const r = resolutionById.get(c.id);
	return r !== undefined && !r.resolvable;
}

function orphanLabel(c: Thread): string | null {
	const r = resolutionById.get(c.id);
	if (r === undefined || r.resolvable || r.reason === null) return null;
	return ORPHAN_LABEL[r.reason];
}

// A resolvable comment on lines, of a commit or of a file as it stands, is
// jumpable; commit-level and orphaned comments are not (D-07 / D-08).
function isJumpable(c: Thread): boolean {
	return (c.anchor !== null || c.content_pin != null) && !isOrphan(c);
}

// The thread J and K move between, and D, X, O, R and Enter act on.
let focusedId = $state<string | null>(null);
// Only the keys draw it: a pointer press already shows where it landed.
let cursorFromKeys = $state(false);
const shownThreads = $derived(
	sections
		.flatMap((section) => section.groups)
		.flatMap((group) =>
			group.threads.filter((thread) => !foldedAway(group, thread)),
		)
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
	cursorFromKeys = true;
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

async function saveAddNote(oid: string, delivery: Delivery) {
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
			delivery,
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

// Copy takes what the panel shows, so the filter decides what the agent reads.
// The button is disabled while the view shows nothing, so the no_threads
// TrunkError from session.generate is reachable only by a race (another window
// deleted the shown threads between render and click), and it lands in the
// same toast as a clipboard failure.
async function onCopyClick() {
	if (!shownReviewId) return;
	const reviewId = shownReviewId;
	const threadIds = visibleComments.map((t) => t.id);

	try {
		const md = await session.generate(repoPath, reviewId, threadIds);
		await writeText(md);
		showToast(
			`Copied ${plural(threadIds.length, "thread")} from ${reviewId} as an agent prompt`,
			"success",
		);
	} catch (e) {
		showToast(`Failed to copy: ${errorMessage(e, "unknown error")}`, "error");
	}
}

// Sending hands the held batch to the agent and deletes nothing. The owner's
// reviews-changed refresh re-reads the review, and with nothing left held the
// button's gate hides it.
async function sendShown() {
	sendPopoverOpen = false;
	if (!shownReviewId) return;
	const reviewId = shownReviewId;

	try {
		await safeInvoke("send_review", { path: repoPath, reviewId });
		showToast(`${reviewId} sent`, "success");
	} catch (e) {
		showToast(
			`Failed to send review: ${errorMessage(e, "unknown error")}`,
			"error",
		);
	}
}

function dismissEndPopover(event: PointerEvent) {
	if (!sendPopoverOpen) return;
	if (event.target instanceof Node && sendAnchor?.contains(event.target))
		return;
	sendPopoverOpen = false;
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
	renameText = reviewTitle(review);
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
							use:selectOnOpen
							class="review-title-field bg-bg text-text-strong shadow-field rounded outline-none h-control py-0 px-1 text-title font-semibold"
						>
					{:else}
						<h1
							class="m-0 min-w-0 truncate text-title font-semibold text-text-strong"
						>
							<LinkButton
								truncate
								title="Click to rename"
								onclick={() => openRename(shownReview)}
								><ReviewTitle title={reviewTitle(shownReview)} /></LinkButton
							>
						</h1>
					{/if}
					<Badge variant="label">{shownReview.id}</Badge>
					<StatePill review={shownReview.state} />
				{/if}
			</div>
			<div class="flex items-center gap-2 ml-auto">
				{#if oncommentonfile && reviewFilter !== "none"}
					<Button
						size="base"
						onclick={oncommentonfile}
						title="Comment on any tracked file, including one no change touches"
					>
						<File size={12} />
						<span>Comment on a file…</span>
					</Button>
				{/if}
				<Button
					size="base"
					onclick={onCopyClick}
					disabled={visibleComments.length === 0}
					title={visibleComments.length === 0
					? "No threads shown to copy"
					: "Copy the shown threads as a prompt for an agent"}
				>
					<Copy size={12} />
					<span>Copy</span>
				</Button>
				{#if shownReview && !shownReview.archived}
					<Button
						size="base"
						onclick={() => archiveReview(repoPath, shownReview.id)}
						title="Put this review away from the list and the agent"
					>
						<Archive size={12} />
						<span>Archive</span>
					</Button>
				{/if}
				{#if shownReview && shownReview.pending_count > 0}
					<div class="relative" bind:this={sendAnchor}>
						<Button
							size="base"
							variant="primary"
							title="Send the held comments to the agent"
							onclick={() => {
							sendPopoverOpen = !sendPopoverOpen;
						}}
						>
							<Send size={12} />
							<span>Send {shownReview.pending_count}</span>
						</Button>
						{#if sendPopoverOpen}
							<div class="send-popover">
								<Dialog
									variant="anchored"
									title="Send {shownReview.id}?"
									onkeydown={(e) => {
									if (e.key === "Escape") sendPopoverOpen = false;
								}}
								>
									<p class="m-0 text-callout leading-normal text-text-muted">
										{sendSummary(shownReview)}
									</p>
									<div class="flex justify-end gap-2">
										<Button
											size="base"
											variant="ghost"
											onclick={() => {
											sendPopoverOpen = false;
										}}
											>Cancel</Button
										>
										<Button size="base" variant="primary" onclick={sendShown}
											>Send</Button
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
				{#if shownReview.archived}
					<span class="font-medium text-text-muted">Archived</span>
					<Button
						size="base"
						onclick={() => unarchiveReview(repoPath, shownReview.id)}
						>Unarchive</Button
					>
				{:else if shownReview.id === activeReviewId}
					<span
						class="inline-flex items-center gap-1 font-medium text-accent-strong"
					>
						<Radio variant="mark" checked />
						Active
					</span>
				{:else}
					<Button
						size="base"
						onclick={() => activateReview(repoPath, shownReview.id)}
						>Make active</Button
					>
				{/if}
				<span class="text-text-disabled" aria-hidden="true">·</span>
				<span
					>{shownReview.visible_to_agent
						? "Visible to the agent"
						: "Not visible to the agent"}</span
				>
				{#if comments.length > 0}
					<span class="text-text-disabled" aria-hidden="true">·</span>
					<ul
						aria-label="Show threads by state"
						class="flex gap-3 list-none m-0 p-0"
					>
						{#each STATE_TALLY as tally (tally.value)}
							{@const count = tallyCount(tally.value)}
							{@const on = tallyOn(tally.value)}
							{@const label = THREAD_LABELS[tally.value]}
							{#if count > 0}
								<li class="inline-flex">
									<LinkButton
										tone="muted"
										aria-pressed={on}
										aria-label="{label} threads"
										onclick={() => toggleTally(tally.value)}
										{@attach fromAction(
											tooltip,
											() =>
												`${label}: ${plural(count, "thread")}. Click to ${on ? "hide" : "show"}.`,
										)}
									>
										<span
											class="inline-flex items-center gap-1 font-mono"
											class:review-toggle-off={!on}
											class:text-text-disabled={!on}
										>
											<span class="inline-flex {tally.tone}" aria-hidden="true">
												<StateGlyph state={tally.value} size={11} />
											</span>
											{count}
										</span>
									</LinkButton>
								</li>
							{/if}
						{/each}
					</ul>
					<span class="flex-1"></span>
					<ButtonGroup size="base">
						{#each THREAD_PRESETS as preset (preset.id)}
							<Button
								joined
								size="base"
								aria-pressed={activePreset === preset.id}
								onclick={() => onreviewfilterchange?.(preset.filter)}
							>
								{preset.label}
								<span class="font-mono"
									>{presetCount(preset.filter.states)}</span
								>
							</Button>
						{/each}
					</ButtonGroup>
				{/if}
			</div>
		{/if}
	</header>
	<div
		bind:this={bodyEl}
		class="review-body flex flex-col flex-1 min-h-0 overflow-auto pb-6 bg-bg text-text text-callout leading-normal"
	>
		{#if reviews.length === 0}
			<ReviewEmpty title="No reviews in this repository">
				{#snippet icon()}
					<ClipboardCheck size={18} />
				{/snippet}
				<p>
					A review collects comment threads on commits and uncommitted work. An
					agent reads each comment through the trunk CLI as soon as you add it,
					replies, and claims fixes for you to confirm.
				</p>
				<p>Your first comment starts a review automatically.</p>
				<WaysToComment />
				{#snippet actions()}
					<Button
						variant="primary"
						size="base"
						onclick={() => startNewReview(repoPath, reviewComments)}
					>
						<Plus size={13} aria-hidden="true" />New review
					</Button>
				{/snippet}
			</ReviewEmpty>
		{:else if !shownReview}
			<ReviewEmpty title="No review is active">
				{#snippet icon()}
					<MessageSquare size={18} />
				{/snippet}
				<p>
					Your next comment starts a new review. Pick one from the list to read
					it.
				</p>
				<WaysToComment />
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
						: shownReview?.archived
							? "Unarchive it to collect new comments here."
							: "Make it active to collect new comments here."}
					The agent reads each comment as soon as you add it, or when you send
					the batch you hold it in.
				</p>
				<WaysToComment />
			</ReviewEmpty>
		{:else if reviewFilter === "none"}
			<div class="flex flex-col gap-1 py-3 px-4">
				<span>Review threads hidden.</span>
				<span class="text-text-muted text-small leading-normal">
					The review inventory remains available above.
				</span>
			</div>
		{:else if !hasVisibleComment}
			<p class="m-0 px-4 py-6 text-text-muted">
				No threads here.
				<LinkButton tone="accent" onclick={showAll}>Show all</LinkButton>
			</p>
		{/if}

		{#each sections as section (section.key)}
			<section
				aria-label={section.branch === null ? "Not on any branch" : `Branch ${section.branch}`}
				style:--lane={sectionLane(section)}
				style:display={hidesSection(section) ? "none" : "block"}
			>
				<header
					class="review-branch-head flex items-center gap-2 h-bar px-4 bg-surface-raised"
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
						{@const groupFolded = isFolded(group.key, group.threads)}
						<li
							aria-label={groupLabel(group)}
							style:display={hidesAll(group.threads) ? "none" : "block"}
						>
							<div
								class="review-group-head flex h-bar bg-surface text-callout text-text"
							>
								<FoldBar
									noun={FOLD_NOUNS[group.kind]}
									inset="group"
									collapsed={groupFolded}
									ontoggle={() => toggleFold(group.key, group.threads)}
								>
									{#snippet lead()}
										<span
											class="inline-flex w-control-xs shrink-0 justify-center"
											><span
												class="review-node"
												data-kind={group.kind}
											></span></span
										>
									{/snippet}
									{#if group.kind === "commit" && group.commit}
										<span class="pointer-events-auto flex">
											<Badge
												title="Copy SHA"
												onclick={() => group.commit && copySha(group.commit.oid)}
												>{group.commit.short_oid}</Badge
											>
										</span>
										<span
											class="pointer-events-auto min-w-0 shrink text-body font-medium text-text-strong"
										>
											<LinkButton
												truncate
												aria-label="Jump to commit {group.commit.short_oid}"
												onclick={() => group.commit && onJumpToCommit(group.commit.oid)}
												>{group.commit.summary}</LinkButton
											>
										</span>
										{#if group.commit.author_timestamp !== null}
											<span
												class="review-meta pointer-events-auto"
												title={exactLabel(group.commit.author_timestamp)}
												>{relativeLabel(group.commit.author_timestamp, currentMinute())}</span
											>
										{/if}
									{:else if group.kind === "gone" && group.commit}
										<Badge variant="label">{group.commit.short_oid}</Badge>
										<span class="min-w-0 truncate text-text-subtle"
											>{group.commit.summary}
											· commit no longer exists</span
										>
									{:else if group.kind === "uncommitted"}
										<span class="text-body font-medium text-text-strong"
											>Uncommitted changes</span
										>
									{:else}
										<span class="text-body font-medium text-text-strong"
											>Current file content · HEAD</span
										>
									{/if}
									<span class="flex-1"></span>
									{#if group.kind === "commit" && group.commit && reviewFilter !== "none"}
										{@const oid = group.commit.oid}
										<span class="pointer-events-auto flex">
											<Button
												size="sm"
												variant="ghost"
												onclick={() => openAddNote(oid)}
												disabled={noteSaving}
											>
												<MessageSquareText size={12} />
												<span>Add note</span>
											</Button>
										</span>
									{/if}
									<span class="review-meta"
										>{plural(shownCount(group.threads), "thread")}</span
									>
								</FoldBar>
							</div>

							<div
								class="review-group-list flex flex-col gap-2"
								style:display={groupFolded ? "none" : "flex"}
							>
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
											submitLabel={noteBatchHeld ? "Add to batch" : "Add note"}
											submitDisabled={!noteDraft.valid || noteSaving}
											onsubmit={() =>
												void saveAddNote(commit.oid, noteBatchHeld ? "hold" : "send")}
											onhold={noteBatchHeld
												? undefined
												: () => void saveAddNote(commit.oid, "hold")}
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
									<span
										class="flex h-bar items-center text-text-muted text-small"
									>
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
									{@const fileFolded = isFolded(fileKey(group, file), file.threads)}
									<div
										class="flex flex-col gap-2 review-file"
										style:display={hidesAll(file.threads) ? "none" : "flex"}
									>
										<div
											class="review-file-head flex h-bar min-w-0 bg-bg text-text-subtle"
										>
											<FoldBar
												noun="file"
												inset="file"
												collapsed={fileFolded}
												ontoggle={() => toggleFold(fileKey(group, file), file.threads)}
											>
												<File size={12} class="shrink-0" aria-hidden="true" />
												<span
													class="pointer-events-auto flex min-w-0 text-small"
												>
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
													>{plural(shownCount(file.threads), "thread")}</span
												>
											</FoldBar>
										</div>
										<ul
											class="flex flex-col gap-2 list-none m-0 p-0"
											style:display={fileFolded ? "none" : "flex"}
										>
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
		{#if hasVisibleComment && hiddenCount > 0}
			<p class="m-0 px-4 pt-3 text-small text-text-muted">
				{plural(hiddenCount, "thread")}
				hidden.
				<LinkButton tone="accent" onclick={showAll}>Show all</LinkButton>
			</p>
		{/if}
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
		cursorShown={cursorFromKeys}
		onfocusrequest={() => {
			focusedId = comment.id;
			cursorFromKeys = false;
		}}
		onjump={jump}
		jumpable={isJumpable(comment)}
		orphaned={isOrphan(comment)}
		orphanLabel={orphanLabel(comment)}
		{editorSessionForThread}
	/>
{/snippet}

<style>
.review-toggle-off {
	outline: 1px dashed var(--color-border-strong);
	outline-offset: calc(3 * var(--u) / 4);
	border-radius: var(--radius);
}

/* The title gives way to the actions only down to a readable width, and past
   that the actions wrap onto their own row. */
.review-title-row {
	flex: 1 1 var(--review-title-min);
}

/* A branch's section: its head stays in view while its commits scroll under
   it, and each commit's head stays under that. */
.review-branch-head {
	position: sticky;
	top: 0;
	z-index: 4;
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
.review-group-head {
	position: sticky;
	top: var(--bar-h);
	z-index: 3;
	box-shadow: var(--shadow-hairline);
}
/* A file's bar stays under its commit's head while the file's threads scroll,
   so every card in view shows its branch, its commit and its file. */
.review-file-head {
	position: sticky;
	top: calc(2 * var(--bar-h));
	z-index: 2;
}
/* A card the keys move to stops below those three bars, not under them. */
.review-body {
	scroll-padding-top: calc(3 * var(--bar-h));
}
.review-node {
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
/* A commit's files and cards start under its chevron, past the slot that holds
   its dot, and the commit ends in its own hairline 16px under them. A file's
   bar sits right under the commit's, and anything else 8px under it. */
.review-group-list {
	padding: 0 var(--space-4) var(--space-4)
		calc(var(--space-4) + var(--control-xs-h) + var(--space-2));
	box-shadow: var(--shadow-hairline);
}
.review-group-list > :first-child:not(.review-file) {
	margin-top: var(--space-2);
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

/* The Send popover, under its button and aligned to its trailing edge. */
.send-popover {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	width: calc(80 * var(--u));
	margin-top: var(--space-1);
}
</style>
