<script lang="ts">
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import type { DiffNav } from "../../lib/diff-nav.js";
import { isMarkdownPath } from "../../lib/markdown.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
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
	onlineenter: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
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
	oncommentfullfile: (filePath: string, selectedIndices: Set<number>) => void;
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
	onlineenter,
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
	reviewFilter = "all",
	viewComments = [],
	editorSessionForThread,
	oncommentfullfile,
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
</script>

<!-- Every view mounted here owns its own scroller, so this wrapper must never be
     one: two scrollers on the same axis give the wheel two places to go, and a
     reader who reaches the end of the inner one drags it up out of the window.
     `clip`, not `hidden`: a hidden overflow is still a scroll container that
     scrollIntoView and scroll chaining can move, and WebKit hands it a phantom
     scroll range the size of the rendered pane's content (TRUNK-127). -->
<div style="flex: 1; overflow: clip; min-height: 0; position: relative; container-type: inline-size; overscroll-behavior-x: none;">
  {#if fileDiffs.length === 0 && commitDetail === null && !loading && !loadError}
    <div style="
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-text-muted);
      font-size: 13px;
    ">
      Select a file or commit to view its diff
    </div>
  {:else if emptyCommit}
    <div style="
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-text-muted);
      font-size: 13px;
    ">
      Empty commit — no changes
    </div>
  {:else if renderMode === "rendered" && selectedPath && isMarkdownPath(selectedPath) && selectedFileDiff}
    <RenderedDiff
      {layoutMode}
      selectedPath={selectedPath}
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
	{:else if loadError}
		<div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); color: var(--color-text-muted); font-size: 13px;">
			<span>Could not load diff</span>
			<span>{loadError}</span>
			{#if onretry}
				<button class="retry-button" type="button" onclick={onretry}>Retry</button>
			{/if}
    </div>
  {:else if loading}
    <div style="height: 100%; display: flex; align-items: center; justify-content: center; color: var(--color-text-muted); font-size: 13px;">
      Loading diff…
    </div>
  {:else if layoutMode === "inline" && contentMode === "hunk"}
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
      {onlineenter}
      onstagehunk={onstagehunk}
      onunstagehunk={onunstagehunk}
      ondiscardhunk={ondiscardhunk}
      onstagelines={onstagelines}
      onunstagelines={onunstagelines}
      ondiscardlines={ondiscardlines}
      oncommentlines={oncommentlines}
      oncommenthunk={oncommenthunk}
      {repoPath}
      {reviewCommentsVisible}
      {reviewFilter}
      {viewComments}
      {editorSessionForThread}
    />
  {:else if layoutMode === "inline" && contentMode === "full"}
    <FullFileView
      bind:this={fullFileView}
      {fileDiffs}
      {showInvisibles}
      {wordWrap}
      {repoPath}
      {diffKind}
      {isMerge}
      {oncommentfullfile}
      {reviewCommentsVisible}
      {reviewFilter}
      {viewComments}
      {editorSessionForThread}
    />
  {:else}
    <SplitView bind:this={diffNav}
      {contentMode} {fileDiffs} {selectedPath} {diffKind}
      {hunkOperationInFlight} {showInvisibles} {wordWrap}
      {selectedHunkKey} {selectedLineIndices} {selectedCount} {isMerge}
      {collapsedFiles}
      {onfilecollapsetoggle} {onlineclick} {onlinemousedown} {onlineenter}
      onstagehunk={onstagehunk} onunstagehunk={onunstagehunk} ondiscardhunk={ondiscardhunk}
      onstagelines={onstagelines} onunstagelines={onunstagelines} ondiscardlines={ondiscardlines}
      oncommentlines={oncommentlines} oncommenthunk={oncommenthunk}
      {repoPath} {reviewCommentsVisible} {reviewFilter} {viewComments} {editorSessionForThread} />
	{/if}
</div>

<style>
	.retry-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--target-min);
		padding: 0 var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
	}

	.retry-button:hover {
		background: var(--color-hover);
	}

	.retry-button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
