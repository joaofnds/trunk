<script lang="ts">
import {
	buildDiffAnchor,
	type DiffAnchorResult,
	hunkSelectableIndices,
	resolveSide,
} from "../lib/diff-anchor.js";
import {
	buildFullFileAnchor,
	fileSelectableIndices,
} from "../lib/full-file-anchor.js";
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import {
	getDiffContentMode,
	getDiffContextLines,
	getDiffIgnoreWhitespace,
	getDiffLayoutMode,
	getDiffShowFullFile,
	getDiffShowInvisibles,
	getDiffWordWrap,
	getRenderMode,
	setDiffContentMode,
	setDiffIgnoreWhitespace,
	setDiffLayoutMode,
	setDiffShowFullFile,
	setDiffShowInvisibles,
	setDiffWordWrap,
	setRenderMode,
} from "../lib/store.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	Comment,
	CommitDetail,
	ContentMode,
	DiffLine,
	DiffOrigin,
	DiffRequestOptions,
	FileDiff,
	LayoutMode,
	RenderMode,
	SessionStatus,
	Side,
} from "../lib/types.js";
import CommentComposer from "./diff/CommentComposer.svelte";
import DiffToolbar from "./diff/DiffToolbar.svelte";
import DiffViewer from "./diff/DiffViewer.svelte";
import type FullFileView from "./diff/FullFileView.svelte";

interface Props {
	fileDiffs: FileDiff[];
	commitDetail: CommitDetail | null;
	selectedPath?: string | null;
	onclose: () => void;
	diffKind?: "unstaged" | "staged" | "commit";
	repoPath?: string;
	onhunkaction?: (filePath: string) => Promise<void>;
	onfileemptied?: (
		filePath: string,
		action: "stage" | "unstage" | "discard",
	) => void;
	ondiffoptionschange?: (options: DiffRequestOptions) => void;
	loading?: boolean;
	showInlineComments?: boolean;
	viewComments?: Comment[];
}

let {
	fileDiffs,
	commitDetail,
	selectedPath = null,
	onclose,
	diffKind = "commit",
	repoPath = "",
	onhunkaction,
	onfileemptied,
	ondiffoptionschange,
	loading = false,
	showInlineComments = true,
	viewComments = [],
}: Props = $props();

let contentMode = $state<ContentMode>("hunk");
let layoutMode = $state<LayoutMode>("inline");
let renderMode = $state<RenderMode>("source");
let contextLines = $state(3);
let ignoreWhitespace = $state(false);
let showInvisibles = $state(false);
let wordWrap = $state(false);
let hunkOperationInFlight = $state(false);

let focusedHunkIndex = $state(0);
let hunkElements = $state<Record<string, HTMLDivElement>>({});

let selectedHunkKey = $state<string | null>(null);
let selectedLineIndices = $state<Set<number>>(new Set());
let lastClickedIndex = $state<number | null>(null);
let selectedCount = $derived(selectedLineIndices.size);

// Drag-to-select state. A drag paints selection across contiguous lines within a
// single hunk: the start line's current state picks the mode (start unselected →
// the drag selects, start selected → it deselects), then each line the cursor
// enters fills the range [anchor..current] against the snapshot taken at drag start.
// `dragging` plus the per-event `e.buttons === 1` guard make a stuck drag inert.
let dragging = false;
let dragMode: "add" | "remove" = "add";
let dragAnchorIndex: number | null = null;
let dragBaseSet: Set<number> | null = null;
let dragHunkLines: DiffLine[] | null = null;

let collapsedFiles = $state<Set<string>>(new Set());

// Commit-diff comment composer host state (Phase 67). `commitOid` and `isMerge`
// derive from the threaded commitDetail; the composer opens for a specific
// (file, hunk) when the user clicks the Comment affordance.
//
// Working-tree (unstaged) commenting (260531-k4j): the anchor's commit_oid is the
// get-or-create snapshot OID returned by ensure_working_tree_snapshot, not a
// commitDetail oid (commitDetail is null for the working tree). Scope commitOid
// to the mode so a stale snapshot oid can never leak into staged/commit views.
let workingTreeSnapshotOid = $state<string | null>(null);
const commitOid = $derived(
	diffKind === "unstaged"
		? (workingTreeSnapshotOid ?? "")
		: (commitDetail?.oid ?? ""),
);
const isMerge = $derived((commitDetail?.parent_oids.length ?? 0) > 1);
let composerOpen = $state(false);
// The diff-path capture is built ONCE, synchronously, when the composer opens (range +
// excerpt from the hunk) and injected as a stable `captured` result — NOT derived
// reactively from selectedLineIndices. The commit_oid is left empty here and filled at
// submit by resolveCommentCommitOid. Capturing up-front keeps the range immune to a
// later selection clear (e.g. a repo-changed-driven diff refetch), which otherwise
// recomputed it over an emptied selection → Math.min(...[]) = Infinity (260531-l02).
let diffCaptured = $state<DiffAnchorResult | null>(null);
let composer = $state<CommentComposer | null>(null);

// Full-file capture host state (Phase 68). The selection lives in FullFileView;
// the host receives the chosen flat indices on the Comment affordance click and
// builds the captured FullFile anchor + plain excerpt via the 68-01 adapter,
// then reuses CommentComposer with that injected result. Merge commits ARE valid
// here (L-05) — no isMerge guard, unlike the diff path.
let fullFileView = $state<FullFileView | null>(null);
let fullFileComposerOpen = $state(false);
let fullFileComposerPath = $state<string | null>(null);
let fullFileSelectedIndices = $state<Set<number>>(new Set());

const fullFileCaptured = $derived(
	fullFileComposerPath
		? (() => {
				const fd = fileDiffs.find((f) => f.path === fullFileComposerPath);
				return fd
					? buildFullFileAnchor(commitOid, fd, fullFileSelectedIndices)
					: null;
			})()
		: null,
);

function closeComposer() {
	composerOpen = false;
	diffCaptured = null;
	fullFileComposerOpen = false;
	fullFileComposerPath = null;
	fullFileSelectedIndices = new Set();
	workingTreeSnapshotOid = null;
	clearSelection();
}

// Auto-start a review session when the user goes to comment with none active.
// The add_comment / save_draft_comment commands stay dumb writers (L-08); the
// session is established here at the capture chokepoint so the composer never
// opens onto a backend that returns no_session. start/resume emit
// session-changed, so the review panel flips to "active" as visible feedback.
async function ensureActiveSession(): Promise<boolean> {
	let state: SessionStatus["state"];
	try {
		const status = await safeInvoke<SessionStatus>(
			"get_review_session_status",
			{ path: repoPath },
		);
		state = status.state;
	} catch (e) {
		showToast(
			(e as TrunkError).message ?? "Failed to load review session",
			"error",
		);
		return false;
	}

	if (state === "active") return true;

	const command =
		state === "resume-available"
			? "resume_review_session"
			: "start_review_session";
	try {
		await safeInvoke(command, { path: repoPath });
		return true;
	} catch (e) {
		showToast(
			(e as TrunkError).message ?? "Failed to start review session",
			"error",
		);
		return false;
	}
}

// Open the comment composer SYNCHRONOUSLY. The composer only needs the line range,
// which comes from the hunk. The EXPENSIVE working-tree snapshot is deferred to
// submit (resolveCommentCommitOid) — that's what removed the click-to-open lag and
// the .git write (+ its self-inflicted reload) during compose. The session IS started
// here, though: it's cheap (a status check, no git hashing) and the composer's
// draft-save fires on the first keystroke — deferring it left drafts hitting
// `no_session` (260531-l02c regression).
async function openDiffComposer(
	fd: FileDiff,
	hunkIndex: number,
	indices: Set<number>,
) {
	if (isMerge) return;
	if (indices.size === 0) return;

	// Working-tree (unstaged) scope guard (260531-k4j): New-side only this pass. Use
	// the SAME exported resolveSide buildDiffAnchor uses so guard and anchor agree on
	// the mixed Add+Delete → New edge case. Commit-mode + staged are NOT guarded
	// (staged anchors to the index snapshot whose parent is HEAD, so Old resolves too).
	// Runs BEFORE ensureActiveSession so a guarded-out comment starts no session.
	if (diffKind === "unstaged") {
		const hunkLines = fd.hunks[hunkIndex]?.lines ?? [];
		const selected = Array.from(indices)
			.sort((a, b) => a - b)
			.map((i) => hunkLines[i]);
		if (resolveSide(fd.status, selected) === "Old") {
			showToast("Commenting on removed lines isn't supported yet", "error");
			return;
		}
	}

	const ready = await ensureActiveSession();
	if (!ready) return;

	// commit_oid is filled at submit by resolveCommentCommitOid; the range + excerpt
	// (all the composer renders) come from the hunk and are stable from this instant.
	diffCaptured = buildDiffAnchor("", fd, hunkIndex, indices);
	composerOpen = true;
}

// Deferred submit-time resolution (260531-l02 lag fix): start the review session and,
// for the working tree, create/reuse the snapshot commit — returning the anchor's
// commit_oid. Runs ONLY when the user submits, so opening is instant and Cancel is
// free. Returns null on failure; the composer stays open so the draft isn't lost.
//
// Snapshot kind by diff (the staged/unstaged base differ — see ensure_review_snapshot):
// - unstaged → "workdir" (HEAD→working tree); the unstaged diff's New side is the workdir.
// - staged   → "index"   (HEAD→index); the staged diff's New side is the index, and its
//              Old side is HEAD = the index snapshot's parent, so both sides resolve.
// - commit   → the viewed commit's oid (no snapshot).
async function resolveCommentCommitOid(): Promise<string | null> {
	const ready = await ensureActiveSession();
	if (!ready) return null;
	if (diffKind === "commit") return commitDetail?.oid ?? "";
	const kind = diffKind === "staged" ? "index" : "workdir";
	try {
		const oid = await safeInvoke<string>("ensure_review_snapshot", {
			path: repoPath,
			kind,
		});
		if (diffKind === "unstaged") workingTreeSnapshotOid = oid;
		return oid;
	} catch (e) {
		showToast(
			(e as TrunkError).message ?? "Failed to snapshot changes",
			"error",
		);
		return null;
	}
}

// Comment on the user's current line selection.
async function handleCommentLines(filePath: string, hunkIndex: number) {
	const fd = fileDiffs.find((f) => f.path === filePath);
	if (!fd) return;
	await openDiffComposer(fd, hunkIndex, new Set(selectedLineIndices));
}

// Whole-hunk Comment affordance (260531-l02): comment a hunk without first
// selecting lines. Synthesize the hunk's selectable (non-context) indices and open
// the composer with that stable set. Does NOT mutate the visible selection.
async function handleCommentHunk(filePath: string, hunkIndex: number) {
	const fd = fileDiffs.find((f) => f.path === filePath);
	const hunk = fd?.hunks[hunkIndex];
	if (!fd || !hunk) return;
	await openDiffComposer(fd, hunkIndex, hunkSelectableIndices(hunk));
}

// Full-file analog. NO isMerge guard (merge commits are valid for full-file, L-05),
// NO Old-side guard (full-file is always New-side, buildFullFileAnchor). Starts the
// session here (cheap; the draft-save needs it — see openDiffComposer); the EXPENSIVE
// working-tree snapshot stays deferred to submit (resolveCommentCommitOid).
async function handleCommentFullFile(filePath: string, indices: Set<number>) {
	const ready = await ensureActiveSession();
	if (!ready) return;
	fullFileComposerPath = filePath;
	fullFileSelectedIndices = indices;
	fullFileComposerOpen = true;
}

// One-click whole-file Comment (260531-l02e): comment every change in the file
// without first selecting lines or switching to full-file view — the file-level
// analog of "Comment Hunk". Synthesizes the file's new-side line set and reuses
// the full-file composer path (Source=FullFile, New-side, snapshot-resolved at
// submit). A pure-deletion file has no new side → deferred, same as the diff
// guard. Operates on the toolbar's current `selectedPath` (like Stage File).
async function handleCommentFile() {
	if (!selectedPath) return;
	const fd = fileDiffs.find((f) => f.path === selectedPath);
	if (!fd) return;
	const indices = fileSelectableIndices(fd);
	if (indices.size === 0) {
		showToast("Commenting on removed lines isn't supported yet", "error");
		return;
	}
	await handleCommentFullFile(fd.path, indices);
}

$effect(() => {
	Promise.all([
		getDiffContentMode(),
		getDiffLayoutMode(),
		getDiffContextLines(),
		getDiffIgnoreWhitespace(),
		getDiffShowInvisibles(),
		getDiffWordWrap(),
		getRenderMode(),
	])
		.then(([cm, lm, cl, iw, si, ww, rm]) => {
			contentMode = cm;
			layoutMode = lm;
			contextLines = cl;
			ignoreWhitespace = iw;
			showInvisibles = si;
			wordWrap = ww;
			renderMode = rm;
		})
		.catch(() => {});
});

function currentDiffOptions(
	overrides?: Partial<DiffRequestOptions>,
): DiffRequestOptions {
	return {
		contextLines,
		ignoreWhitespace,
		showFullFile: contentMode === "full",
		...overrides,
	};
}

async function handleContentModeChange(mode: ContentMode) {
	contentMode = mode;
	const shouldShowFull = mode === "full";
	clearSelection();
	ondiffoptionschange?.(currentDiffOptions({ showFullFile: shouldShowFull }));
	Promise.all([setDiffContentMode(mode), setDiffShowFullFile(shouldShowFull)]);
}

async function handleLayoutModeChange(mode: LayoutMode) {
	layoutMode = mode;
	clearSelection();
	setDiffLayoutMode(mode);
}

function handleRenderModeChange(mode: RenderMode) {
	renderMode = mode;
	setRenderMode(mode);
}

async function handleIgnoreWhitespaceChange(value: boolean) {
	ignoreWhitespace = value;
	ondiffoptionschange?.(currentDiffOptions({ ignoreWhitespace: value }));
	setDiffIgnoreWhitespace(value);
}

function handleShowInvisiblesChange(value: boolean) {
	showInvisibles = value;
	setDiffShowInvisibles(value);
}

function handleWordWrapChange(value: boolean) {
	wordWrap = value;
	setDiffWordWrap(value);
}

function clearSelection() {
	selectedHunkKey = null;
	selectedLineIndices = new Set();
	lastClickedIndex = null;
	// Reset the full-file view's own selection state so it never goes stale across
	// mode/layout toggles or Escape (null when not mounted in full-file mode).
	fullFileView?.clearSelection();
}

function scrollToHunk(index: number) {
	const keys = Object.keys(hunkElements);
	if (index < 0 || index >= keys.length) return;
	focusedHunkIndex = index;
	const el = hunkElements[keys[index]];
	el?.scrollIntoView({ behavior: "smooth", block: "start" });
	el?.classList.add("hunk-highlight");
	setTimeout(() => el?.classList.remove("hunk-highlight"), 600);
}

// Jump-to-range (Phase 69 / D-07): scroll to and transiently highlight the hunk
// that contains a comment's anchored line range. The review panel jump resolves
// to a single rendered file; we locate the hunk whose old/new-line span covers
// `startLine`, branching on `side` because an Old-side anchor's line number is
// a parent-tree coordinate and a New-side anchor's is a commit-tree coordinate.
// In hunk view the hunk wrapper is the scroll target. This is best-effort —
// if the line isn't currently rendered (e.g. full-file mode or no matching
// hunk), it falls back to the first hunk so the file is at least brought into
// view rather than leaving the user stranded.
export function scrollToLine(
	startLine: number,
	_endLine: number,
	side: Side = "New",
) {
	const keys = Object.keys(hunkElements);
	if (keys.length === 0) return;
	let targetKey: string | null = null;
	for (const fd of fileDiffs) {
		for (let hunkIdx = 0; hunkIdx < fd.hunks.length; hunkIdx++) {
			const hunk = fd.hunks[hunkIdx];
			const start = side === "Old" ? hunk.old_start : hunk.new_start;
			const lines = side === "Old" ? hunk.old_lines : hunk.new_lines;
			const end = start + lines - 1;
			if (startLine >= start && startLine <= end) {
				targetKey = `${fd.path}-${hunkIdx}`;
				break;
			}
		}
		if (targetKey !== null) break;
	}
	const index = targetKey !== null ? keys.indexOf(targetKey) : 0;
	scrollToHunk(index >= 0 ? index : 0);
}

function toggleFileCollapsed(path: string) {
	const next = new Set(collapsedFiles);
	if (next.has(path)) next.delete(path);
	else next.add(path);
	collapsedFiles = next;
}

$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

		if (e.key === "Escape" && selectedCount > 0) {
			e.preventDefault();
			clearSelection();
			return;
		}

		if (e.key === "]") {
			e.preventDefault();
			scrollToHunk(focusedHunkIndex + 1);
		} else if (e.key === "[") {
			e.preventDefault();
			scrollToHunk(focusedHunkIndex - 1);
		}
	}
	function handleMouseUp() {
		dragging = false;
	}
	window.addEventListener("keydown", handleKeydown);
	window.addEventListener("mouseup", handleMouseUp);
	return () => {
		window.removeEventListener("keydown", handleKeydown);
		window.removeEventListener("mouseup", handleMouseUp);
	};
});

$effect(() => {
	fileDiffs;
	focusedHunkIndex = 0;
	hunkElements = {};
	clearSelection();
	collapsedFiles = new Set();
});

function isLastHunk(filePath: string): boolean {
	const fd = fileDiffs.find((f) => f.path === filePath);
	return !fd || fd.hunks.length <= 1;
}

async function handleStageFile() {
	if (!selectedPath || hunkOperationInFlight) return;
	const path = selectedPath;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("stage_file", { path: repoPath, filePath: path });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Stage file failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	onfileemptied?.(path, "stage");
}

async function handleUnstageFile() {
	if (!selectedPath || hunkOperationInFlight) return;
	const path = selectedPath;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("unstage_file", {
			path: repoPath,
			filePath: path,
		});
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Unstage file failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	onfileemptied?.(path, "unstage");
}

async function handleDiscardFile() {
	if (!selectedPath || hunkOperationInFlight) return;
	const path = selectedPath;
	const isUntracked =
		fileDiffs.find((f) => f.path === path)?.status === "Untracked";
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		isUntracked
			? `Delete ${path}? This file is untracked and will be permanently removed. This cannot be undone.`
			: `Discard changes to ${path}? This cannot be undone.`,
		{
			title: isUntracked ? "Delete File" : "Discard Changes",
			kind: "warning",
		},
	);
	if (!confirmed) return;

	hunkOperationInFlight = true;
	try {
		await safeInvoke("discard_file", { path: repoPath, filePath: path });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Discard file failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	showToast(`Discarded ${path}`, "success");
	onfileemptied?.(path, "discard");
}

async function handleStageHunk(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("stage_hunk", { path: repoPath, filePath, hunkIndex });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Stage hunk failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	if (isLastHunk(filePath)) {
		onfileemptied?.(filePath, "stage");
	} else {
		await onhunkaction?.(filePath);
	}
}

async function handleUnstageHunk(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("unstage_hunk", { path: repoPath, filePath, hunkIndex });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Unstage hunk failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	if (isLastHunk(filePath)) {
		onfileemptied?.(filePath, "unstage");
	} else {
		await onhunkaction?.(filePath);
	}
}

async function handleDiscardHunk(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask("Discard this hunk? This cannot be undone.", {
		title: "Discard Hunk",
		kind: "warning",
	});
	if (!confirmed) return;

	hunkOperationInFlight = true;
	try {
		await safeInvoke("discard_hunk", { path: repoPath, filePath, hunkIndex });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Discard hunk failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
	}
	showToast("Discarded hunk", "success");
	if (isLastHunk(filePath)) {
		onfileemptied?.(filePath, "discard");
	} else {
		await onhunkaction?.(filePath);
	}
}

async function handleLineClick(
	filePath: string,
	hunkIdx: number,
	lineIndex: number,
	origin: DiffOrigin,
	hunkLines: DiffLine[],
	e: MouseEvent,
) {
	if (origin === "Context") return;

	// D-02: switching to a new range while an open composer holds a dirty draft
	// prompts a discard confirmation. On cancel, keep the current selection and
	// composer; on confirm (or empty draft), close the composer and proceed.
	if (composerOpen && composer) {
		const proceed = await composer.confirmDiscardIfDirty();
		if (!proceed) return;
		composerOpen = false;
		diffCaptured = null;
	}

	const hunkKey = `${filePath}-${hunkIdx}`;

	if (hunkKey !== selectedHunkKey) {
		selectedHunkKey = hunkKey;
		selectedLineIndices = new Set([lineIndex]);
		lastClickedIndex = lineIndex;
		return;
	}

	if (e.shiftKey && lastClickedIndex !== null) {
		e.preventDefault();
		const start = Math.min(lastClickedIndex, lineIndex);
		const end = Math.max(lastClickedIndex, lineIndex);
		const newSet = new Set(selectedLineIndices);
		for (let i = start; i <= end; i++) {
			if (i < hunkLines.length && hunkLines[i].origin !== "Context") {
				newSet.add(i);
			}
		}
		selectedLineIndices = newSet;
	} else {
		const newSet = new Set(selectedLineIndices);
		if (newSet.has(lineIndex)) {
			newSet.delete(lineIndex);
		} else {
			newSet.add(lineIndex);
		}
		selectedLineIndices = newSet;
		lastClickedIndex = lineIndex;
	}
}

// Paint selectedLineIndices for the active drag: range [anchor..current] over the
// snapshot taken at drag start, applying dragMode (Context lines never select).
function applyDragRange(currentIndex: number) {
	if (
		dragAnchorIndex === null ||
		dragBaseSet === null ||
		dragHunkLines === null
	)
		return;
	const start = Math.min(dragAnchorIndex, currentIndex);
	const end = Math.max(dragAnchorIndex, currentIndex);
	const newSet = new Set(dragBaseSet);
	for (let i = start; i <= end; i++) {
		const line = dragHunkLines[i];
		if (!line || line.origin === "Context") continue;
		if (dragMode === "add") newSet.add(i);
		else newSet.delete(i);
	}
	selectedLineIndices = newSet;
}

// Mouse press on a line: starts a drag-paint, or extends the range on Shift.
// Replaces the old click-to-toggle path (a plain click is a zero-length drag, so
// it still toggles); keyboard selection continues to flow through handleLineClick.
async function handleLineMouseDown(
	filePath: string,
	hunkIdx: number,
	lineIndex: number,
	origin: DiffOrigin,
	hunkLines: DiffLine[],
	e: MouseEvent,
) {
	if (origin === "Context") return;
	// Suppress native text selection for the whole gesture — a drag crosses
	// Context lines and gutters that are otherwise user-selectable.
	e.preventDefault();

	// D-02: switching to a new range while an open composer holds a dirty draft
	// prompts a discard confirmation. On cancel, keep selection and composer.
	if (composerOpen && composer) {
		const proceed = await composer.confirmDiscardIfDirty();
		if (!proceed) return;
		composerOpen = false;
		diffCaptured = null;
	}

	const hunkKey = `${filePath}-${hunkIdx}`;

	if (e.shiftKey && hunkKey === selectedHunkKey && lastClickedIndex !== null) {
		const start = Math.min(lastClickedIndex, lineIndex);
		const end = Math.max(lastClickedIndex, lineIndex);
		const newSet = new Set(selectedLineIndices);
		for (let i = start; i <= end; i++) {
			if (i < hunkLines.length && hunkLines[i].origin !== "Context") {
				newSet.add(i);
			}
		}
		selectedLineIndices = newSet;
		lastClickedIndex = lineIndex;
		return;
	}

	if (hunkKey !== selectedHunkKey) {
		selectedHunkKey = hunkKey;
		dragBaseSet = new Set();
		dragMode = "add";
	} else {
		dragBaseSet = new Set(selectedLineIndices);
		dragMode = selectedLineIndices.has(lineIndex) ? "remove" : "add";
	}
	dragAnchorIndex = lineIndex;
	dragHunkLines = hunkLines;
	dragging = true;
	lastClickedIndex = lineIndex;
	applyDragRange(lineIndex);
}

// Cursor enters a line during a drag: extend the painted range. The e.buttons
// guard makes a stuck `dragging` flag inert — without a held button, no paint.
function handleLineEnter(
	filePath: string,
	hunkIdx: number,
	lineIndex: number,
	e: MouseEvent,
) {
	if (!dragging) return;
	if (e.buttons !== 1) {
		dragging = false;
		return;
	}
	if (`${filePath}-${hunkIdx}` !== selectedHunkKey) return;
	applyDragRange(lineIndex);
	lastClickedIndex = lineIndex;
}

async function handleStageLines(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("stage_lines", {
			path: repoPath,
			filePath,
			hunkIndex,
			lineIndices: Array.from(selectedLineIndices),
		});
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Stage lines failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
		clearSelection();
	}
	await onhunkaction?.(filePath);
}

async function handleUnstageLines(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	hunkOperationInFlight = true;
	try {
		await safeInvoke("unstage_lines", {
			path: repoPath,
			filePath,
			hunkIndex,
			lineIndices: Array.from(selectedLineIndices),
		});
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Unstage lines failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
		clearSelection();
	}
	await onhunkaction?.(filePath);
}

async function handleDiscardLines(filePath: string, hunkIndex: number) {
	if (hunkOperationInFlight) return;
	const count = selectedCount;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Discard ${count} selected lines? This cannot be undone.`,
		{
			title: "Discard Lines",
			kind: "warning",
		},
	);
	if (!confirmed) return;

	hunkOperationInFlight = true;
	try {
		await safeInvoke("discard_lines", {
			path: repoPath,
			filePath,
			hunkIndex,
			lineIndices: Array.from(selectedLineIndices),
		});
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Discard lines failed", "error");
		return;
	} finally {
		hunkOperationInFlight = false;
		clearSelection();
	}
	showToast(`Discarded ${count} lines`, "success");
	await onhunkaction?.(filePath);
}
</script>

<div style="height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-1);">
	<DiffToolbar
		{contentMode}
		{layoutMode}
		{renderMode}
		oncontentmodechange={handleContentModeChange}
		onlayoutmodechange={handleLayoutModeChange}
		onrendermodechange={handleRenderModeChange}
		selectedPath={selectedPath}
		{diffKind}
		{hunkOperationInFlight}
		{ignoreWhitespace}
		{showInvisibles}
		{wordWrap}
		{showInlineComments}
		onignorewhitespacechange={handleIgnoreWhitespaceChange}
		onshowinvisibleschange={handleShowInvisiblesChange}
		onwordwrapchange={handleWordWrapChange}
		onstagefile={handleStageFile}
		onunstagefile={handleUnstageFile}
		ondiscardfile={handleDiscardFile}
		oncommentfile={handleCommentFile}
		onclose={onclose}
	/>
	<DiffViewer
		{contentMode}
		{layoutMode}
		{renderMode}
		{fileDiffs}
		{commitDetail}
		{selectedPath}
		{diffKind}
		{loading}
		{hunkOperationInFlight}
		{ignoreWhitespace}
		{showInvisibles}
		{wordWrap}
		{selectedHunkKey}
		{selectedLineIndices}
		{selectedCount}
		{isMerge}
		{collapsedFiles}
		{hunkElements}
		onfilecollapsetoggle={toggleFileCollapsed}
		onlineclick={handleLineClick}
		onlinemousedown={handleLineMouseDown}
		onlineenter={handleLineEnter}
		onstagehunk={handleStageHunk}
		onunstagehunk={handleUnstageHunk}
		ondiscardhunk={handleDiscardHunk}
		onstagelines={handleStageLines}
		onunstagelines={handleUnstageLines}
		ondiscardlines={handleDiscardLines}
		oncommentlines={handleCommentLines}
		oncommenthunk={handleCommentHunk}
		{commitOid}
		{repoPath}
		{showInlineComments}
		{viewComments}
		oncommentfullfile={handleCommentFullFile}
		bind:fullFileView
	/>
	{#if composerOpen && diffCaptured}
		<CommentComposer
			bind:this={composer}
			captured={diffCaptured}
			{commitOid}
			resolveCommitOid={resolveCommentCommitOid}
			{repoPath}
			onclose={closeComposer}
		/>
	{:else if fullFileComposerOpen && fullFileCaptured}
		<CommentComposer
			bind:this={composer}
			captured={fullFileCaptured}
			{commitOid}
			resolveCommitOid={resolveCommentCommitOid}
			{repoPath}
			onclose={closeComposer}
		/>
	{/if}
</div>
