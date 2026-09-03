<script lang="ts">
import type { DiffNav } from "../../lib/diff-nav.js";
import { isMarkdownPath } from "../../lib/markdown.js";
import type {
	CommitDetail,
	ContentMode,
	DiffLine,
	DiffOrigin,
	FileDiff,
	LayoutMode,
	RenderMode,
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
	selectedPath: string | null;
	diffKind: "unstaged" | "staged" | "commit";
	emptyCommit?: boolean;
	loading: boolean;
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
	showInlineComments?: boolean;
	viewComments?: Thread[];
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
	selectedPath,
	diffKind,
	emptyCommit = false,
	loading,
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
	showInlineComments = true,
	viewComments = [],
	oncommentfullfile,
	fullFileView = $bindable(null),
	diffNav = $bindable(null),
	refreshToken = 0,
}: Props = $props();
</script>

<!-- Every view mounted here owns its own scroller, so this wrapper must never be
     one: two scrollers on the same axis give the wheel two places to go, and a
     reader who reaches the end of the inner one drags it up out of the window.
     `clip`, not `hidden`: a hidden overflow is still a scroll container that
     scrollIntoView and scroll chaining can move, and WebKit hands it a phantom
     scroll range the size of the rendered pane's content (TRUNK-127). -->
<div style="flex: 1; overflow: clip; min-height: 0; position: relative; container-type: inline-size; overscroll-behavior-x: none;">
  {#if fileDiffs.length === 0 && commitDetail === null && !loading}
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
  {:else if renderMode === "rendered" && selectedPath && isMarkdownPath(selectedPath)}
    <RenderedDiff
      {layoutMode}
      selectedPath={selectedPath}
      {diffKind}
      {commitOid}
      {repoPath}
      {commitDetail}
      {contentMode}
      {contextLines}
      {ignoreWhitespace}
      {wordWrap}
      {refreshToken}
      {hunkElements}
    />
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
      {showInlineComments}
      {viewComments}
    />
  {:else if layoutMode === "inline" && contentMode === "full"}
    <FullFileView
      bind:this={fullFileView}
      {fileDiffs}
      {showInvisibles}
      {wordWrap}
      {commitOid}
      {repoPath}
      {diffKind}
      {isMerge}
      {oncommentfullfile}
      {showInlineComments}
      {viewComments}
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
      {repoPath} {showInlineComments} {viewComments} />
  {/if}
</div>
