<script lang="ts">
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import type { DiffNav } from "../../lib/diff-nav.js";
import { type DiffComposer, diffHoldsComposer } from "../../lib/diff-rows.js";
import { isMarkdownPath } from "../../lib/markdown.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
import { ALL_THREADS } from "../../lib/review-filter.js";
import type {
	CommitDetail,
	ContentMode,
	DiffLine,
	DiffOrigin,
	FileDiff,
	LayoutMode,
	RenderMode,
	ReviewFilter,
	Thread,
} from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import ReviewEmpty from "../review/ReviewEmpty.svelte";
import FullFileView from "./FullFileView.svelte";
import HunkView from "./HunkView.svelte";
import RenderedDiff from "./RenderedDiff.svelte";
import SplitView from "./SplitView.svelte";

interface Props {
	contentMode: ContentMode;
	contextLines: number;
	layoutMode: LayoutMode;
	renderMode: RenderMode;
	fileDiffs: FileDiff[];
	commitDetail: CommitDetail | null;
	// Set only for a compare selection; forwarded to RenderedDiff so its before
	// side matches the rev the file list's rename pairing was computed against
	// (TRUNK-163).
	compareBaseOid?: string | null;
	selectedPath: string | null;
	diffKind: PanelDiffKind;
	emptyCommit?: boolean;
	loading: boolean;
	/** The payload on screen answers a different content mode than the one asked
	 *  for. Unlike `loading`, it means what is mounted is the wrong shape, so it
	 *  comes down for the placeholder rather than staying up (TRUNK-232). */
	payloadStale?: boolean;
	loadError?: string | null;
	onretry?: () => void;
	hunkOperationInFlight: boolean;
	ignoreWhitespace: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	selectedHunkKey: string | null;
	selectedLineIndices: Set<number>;
	selectedCount: number;
	isMerge: boolean;
	collapsedFiles: Set<string>;
	hunkElements: Record<string, HTMLDivElement>;
	onfilecollapsetoggle: (path: string) => void;
	onlineclick: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		origin: DiffOrigin,
		hunkLines: DiffLine[],
		e: MouseEvent,
	) => void;
	onlinemousedown: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		origin: DiffOrigin,
		hunkLines: DiffLine[],
		e: MouseEvent,
	) => void;
	onstagehunk: (filePath: string, hunkIndex: number) => void;
	onunstagehunk: (filePath: string, hunkIndex: number) => void;
	ondiscardhunk: (filePath: string, hunkIndex: number) => void;
	onstagelines: (filePath: string, hunkIndex: number) => void;
	onunstagelines: (filePath: string, hunkIndex: number) => void;
	ondiscardlines: (filePath: string, hunkIndex: number) => void;
	oncommentlines: (filePath: string, hunkIndex: number) => void;
	oncommenthunk: (filePath: string, hunkIndex: number) => void;
	commitOid: string;
	repoPath: string;
	reviewCommentsVisible?: boolean;
	reviewFilter?: ReviewFilter;
	viewComments?: Thread[];
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	/** The open comment composer, if any. */
	composer?: DiffComposer | null;
	oncommentfullfile: (filePath: string, selectedIndices: Set<number>) => void;
	onextendcomment?: (filePath: string, selectedIndices: Set<number>) => void;
	oncommentline?: (
		filePath: string,
		hunkIndex: number,
		lineIndex: number,
	) => void;
	fullFileView?: import("./FullFileView.svelte").default | null;
	/** Set by the mounted virtualized view, null when none is. */
	diffNav?: DiffNav | null;
	refreshToken?: number;
}

let {
	contentMode,
	contextLines,
	layoutMode,
	renderMode,
	fileDiffs,
	commitDetail,
	compareBaseOid = null,
	selectedPath,
	diffKind,
	emptyCommit = false,
	loading,
	payloadStale = false,
	loadError = null,
	onretry,
	hunkOperationInFlight,
	ignoreWhitespace,
	showInvisibles,
	wordWrap,
	selectedHunkKey,
	selectedLineIndices,
	selectedCount,
	isMerge,
	collapsedFiles,
	hunkElements,
	onfilecollapsetoggle,
	onlineclick,
	onlinemousedown,
	onstagehunk,
	onunstagehunk,
	ondiscardhunk,
	onstagelines,
	onunstagelines,
	ondiscardlines,
	oncommentlines,
	oncommenthunk,
	commitOid,
	repoPath,
	reviewCommentsVisible = true,
	reviewFilter = ALL_THREADS,
	viewComments = [],
	editorSessionForThread,
	composer = null,
	oncommentfullfile,
	onextendcomment,
	oncommentline,
	fullFileView = $bindable(null),
	diffNav = $bindable(null),
	refreshToken = 0,
}: Props = $props();

// The rendered view reads a renamed file's before side by its old name, which
// only this list knows. Until it holds the selected path the pairing is unknown
// rather than absent: selection and the list land on separate clocks in the
// staging path, and fetching on the gap renders a staged rename as all added
// before the correcting fetch arrives (TRUNK-162).
const selectedFileDiff = $derived(
	fileDiffs.find((f) => f.path === selectedPath),
);

// Whether the pane holds content that answers what is being asked for, which is
// what lets a refresh keep it on screen instead of tearing it out for the length
// of the fetch. Two ways it can fail to answer: the caller has marked the
// payload stale, meaning it is the shape of a content mode nobody wants any
// more; or a path is selected and the list does not hold that path's diff yet,
// which is a selection still in flight rather than a refresh. A commit view
// selects no single path, so the whole list is its content.
const hasContent = $derived(
	!payloadStale &&
		(selectedPath !== null
			? isLoaded(selectedFileDiff)
			: fileDiffs.length > 0 || commitDetail !== null),
);

// What the pane shows, in the order the cases take precedence.
const pane = $derived.by(() => {
	if (
		fileDiffs.length === 0 &&
		commitDetail === null &&
		!loading &&
		!payloadStale &&
		!loadError
	)
		return "placeholder";
	if (emptyCommit) return "empty-commit";
	if (
		renderMode === "rendered" &&
		selectedPath &&
		isMarkdownPath(selectedPath) &&
		selectedFileDiff
	)
		return "rendered";
	if (loadError) return "error";
	if ((loading || payloadStale) && !hasContent) return "loading";
	if (selectedFileDiff && !isLoaded(selectedFileDiff)) return "no-changes";
	if (layoutMode === "inline") return contentMode === "hunk" ? "hunk" : "full";
	return "split";
});

// The composer sits under its line when a line view shows that line. Anywhere
// else (the rendered Markdown, a load error, a line a refetch took away) it
// sits below the diff, so a draft in progress never leaves the screen.
const inlineComposer = $derived(
	composer !== null &&
		(pane === "hunk" || pane === "full" || pane === "split") &&
		diffHoldsComposer(fileDiffs, composer.place, collapsedFiles)
		? composer
		: null,
);

// A commit's file list arrives as one hunkless entry per file before any of
// them is fetched, so a hunkless entry is metadata rather than content. A
// binary file carries no hunks either and is content all the same.
function isLoaded(diff: FileDiff | undefined): boolean {
	return diff !== undefined && (diff.hunks.length > 0 || diff.is_binary);
}
</script>

<!-- Every view mounted here owns its own scroller, so this wrapper must never be
     one: two scrollers on the same axis give the wheel two places to go, and a
     reader who reaches the end of the inner one drags it up out of the window.
     `clip`, not `hidden`: a hidden overflow is still a scroll container that
     scrollIntoView and scroll chaining can move, and WebKit hands it a phantom
     scroll range the size of the rendered pane's content (TRUNK-127). -->
<div class="flex-1 overflow-clip min-h-0 relative @container overscroll-x-none">
	{#if pane === "placeholder"}
		<div
			class="flex-1 flex items-center justify-center text-text-muted text-body"
		>
			Select a file or commit to view its diff
		</div>
	{:else if pane === "empty-commit"}
		<div
			class="flex-1 flex items-center justify-center text-text-muted text-body"
		>
			Empty commit — no changes
		</div>
	{:else if pane === "rendered" && selectedPath && selectedFileDiff}
		<RenderedDiff
			{layoutMode}
			{selectedPath}
			oldPath={selectedFileDiff.old_path}
			{diffKind}
			{commitOid}
			{repoPath}
			{commitDetail}
			{compareBaseOid}
			{contentMode}
			{contextLines}
			{ignoreWhitespace}
			{wordWrap}
			{refreshToken}
			{hunkElements}
		/>
	{:else if pane === "error"}
		<div
			class="h-full flex flex-col items-center justify-center gap-2 text-text-muted text-body"
		>
			<span>Could not load diff</span>
			<span>{loadError}</span>
			{#if onretry}
				<Button data-testid="diff-retry" onclick={onretry}>Retry</Button>
			{/if}
		</div>
	{:else if pane === "loading"}
		<div
			class="h-full flex items-center justify-center text-text-muted text-body"
		>
			Loading diff…
		</div>
	{:else if pane === "no-changes"}
		<ReviewEmpty title="No changes to show">
			<p>This file has no diff here.</p>
		</ReviewEmpty>
	{:else if pane === "hunk"}
		<HunkView
			bind:this={diffNav}
			{fileDiffs}
			{selectedPath}
			{diffKind}
			{hunkOperationInFlight}
			{showInvisibles}
			{wordWrap}
			{selectedHunkKey}
			{selectedLineIndices}
			{selectedCount}
			{isMerge}
			{collapsedFiles}
			{onfilecollapsetoggle}
			{onlineclick}
			{onlinemousedown}
			{onstagehunk}
			{onunstagehunk}
			{ondiscardhunk}
			{onstagelines}
			{onunstagelines}
			{ondiscardlines}
			{oncommentlines}
			{oncommenthunk}
			{oncommentline}
			{repoPath}
			{reviewCommentsVisible}
			{reviewFilter}
			{viewComments}
			{editorSessionForThread}
			composer={inlineComposer}
		/>
	{:else if pane === "full"}
		<FullFileView
			bind:this={fullFileView}
			{fileDiffs}
			{showInvisibles}
			{wordWrap}
			{repoPath}
			{diffKind}
			{isMerge}
			{oncommentfullfile}
			{onextendcomment}
			{reviewCommentsVisible}
			{reviewFilter}
			{viewComments}
			{editorSessionForThread}
			composer={inlineComposer}
		/>
	{:else}
		<SplitView
			bind:this={diffNav}
			{contentMode}
			{fileDiffs}
			{selectedPath}
			{diffKind}
			{hunkOperationInFlight}
			{showInvisibles}
			{wordWrap}
			{selectedHunkKey}
			{selectedLineIndices}
			{selectedCount}
			{isMerge}
			{collapsedFiles}
			{onfilecollapsetoggle}
			{onlineclick}
			{onlinemousedown}
			{onstagehunk}
			{onunstagehunk}
			{ondiscardhunk}
			{onstagelines}
			{onunstagelines}
			{ondiscardlines}
			{oncommentlines}
			{oncommenthunk}
			{oncommentline}
			{repoPath}
			{reviewCommentsVisible}
			{reviewFilter}
			{viewComments}
			{editorSessionForThread}
			composer={inlineComposer}
		/>
	{/if}
</div>
{#if composer && !inlineComposer}
	<div class="flex">{@render composer.card()}</div>
{/if}
