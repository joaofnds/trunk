<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import X from "@lucide/svelte/icons/x";
import { copySha, copyText } from "../lib/clipboard.js";
import { fileCountsForOid, fileTalliesForOid } from "../lib/comment-counts.js";
import type { Draft } from "../lib/draft.svelte.js";
import { pathMenuEntriesOf } from "../lib/file-menu.js";
import { toFileStatusList } from "../lib/file-status.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import type { ThreadEditorSession } from "../lib/review-editors.svelte.js";
import type {
	CommitDetail,
	CommitNav,
	DiffStat,
	FileDiff,
	FileStatus,
	ReviewFilter,
	ReviewTally,
	Thread,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import CommitAuthor from "./CommitAuthor.svelte";
import CommitMessage from "./CommitMessage.svelte";
import CommitNotes from "./CommitNotes.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	commitDetail: CommitDetail;
	/** Whole-commit totals; null while they load (the bar shows the file count only). */
	stat?: DiffStat | null;
	fileDiffs: FileDiff[];
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	onclose: () => void;
	repoPath?: string;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
	nav?: CommitNav | null;
	onnavigate?: (oid: string) => void;
	/** False while the review panel holds the center, whose J and K move between threads. */
	pagerKeys?: boolean;
	// The shared comments store, threaded from RepoView so the commit-notes block
	// and the per-file badges read one source of truth.
	reviewComments?: ReviewCommentsManager;
	// Center-pane review visibility; gates the per-file count badges.
	reviewCommentsVisible?: boolean;
	reviewFilter?: ReviewFilter;
	commentCounts?: Map<string, number>;
	commentTallies?: Map<string, ReviewTally>;
	activeReviewId?: string | null;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	editorDraftFor?: (
		reviewId: string | null,
		surface: string,
		target: string,
	) => Draft;
}

let {
	commitDetail,
	stat = null,
	fileDiffs,
	selectedFile,
	onfileselect,
	onclose,
	repoPath = "",
	treeViewEnabled = false,
	ontreeviewtoggle,
	nav = null,
	onnavigate,
	pagerKeys = true,
	reviewComments,
	reviewCommentsVisible = false,
	reviewFilter = "all",
	commentCounts,
	commentTallies,
	activeReviewId = null,
	editorSessionForThread,
	editorDraftFor,
}: Props = $props();

// Per-file comment counts for this commit's file list. Gated so the badges
// follow the toggle + an active session; keyed by the commit's own OID so the
// badge can never disagree with what the diff pane shows for the same file.
let fileCommentCounts = $derived(
	reviewCommentsVisible
		? fileCountsForOid(
				commentCounts ?? reviewComments?.countByFile ?? new Map(),
				commitDetail.oid,
			)
		: new Map<string, number>(),
);
let fileCommentTallies = $derived(
	reviewCommentsVisible
		? fileTalliesForOid(commentTallies ?? new Map(), commitDetail.oid)
		: new Map<string, ReviewTally>(),
);

let fileStatusList = $derived<FileStatus[]>(toFileStatusList(fileDiffs));

async function showFileContextMenu(e: MouseEvent, file: FileStatus) {
	e.preventDefault();
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: await Promise.all(
			pathMenuEntriesOf(repoPath, file.path, file.old_path ?? null).map(
				(entry) =>
					MenuItem.new({
						text: entry.text,
						action: () => {
							copyText(entry.value);
						},
					}),
			),
		),
	});
	await menu.popup();
}

// j/k step older/newer through the same navigate path as the pager, so review
// flows without focusing the graph. Vim-style: j = down = older, k = up = newer.
// Arrow keys are left to CommitGraph's own (container-scoped) handler.
function handlePaneKeydown(e: KeyboardEvent) {
	if (!nav || !pagerKeys) return;
	const chord = keyChord(e);
	if (chord !== "j" && chord !== "k") return;
	if (focusInEditable(document.activeElement)) return;

	const target = chord === "j" ? nav.olderOid : nav.newerOid;
	if (target === null) return;

	e.preventDefault();
	onnavigate?.(target);
}

let totalAdds = $derived(stat?.insertions ?? 0);
let totalDels = $derived(stat?.deletions ?? 0);

// Commit-level notes (anchor === null) for THIS commit, read from the shared
// rune. Whole-commit notes carry no anchor; they belong to the commit by
// commit_oid (plan §2).
let commitNotes = $derived(
	(reviewComments?.threads ?? []).filter(
		(t) => t.anchor === null && t.commit_oid === commitDetail.oid,
	),
);
</script>

<svelte:window onkeydown={handlePaneKeydown} />

<div
	data-testid="commit-detail"
	class="w-full min-w-0 flex flex-col h-full overflow-hidden bg-surface"
>
	<!-- Toolbar -->
	<div class="h-bar shadow-hairline py-0 px-2 flex items-center gap-2 shrink-0">
		<span
			class="text-small text-text-muted font-mono flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
		>
			commit:
			<span
				class="inline-flex items-center rounded bg-surface-chip px-2 py-1 text-text-strong"
			>
				<LinkButton
					mono
					title="Copy SHA"
					onclick={() => copySha(commitDetail.oid)}
					>{commitDetail.short_oid}</LinkButton
				>
			</span>
		</span>
		{#if nav}
			<span class="pager">
				<Button
					icon
					size="sm"
					variant="ghost"
					aria-label="Go to newer commit"
					title="Newer commit"
					disabled={nav.newerOid === null}
					onclick={() => nav?.newerOid && onnavigate?.(nav.newerOid)}
					><ChevronUp size={13} /></Button
				>
				<span class="pager-pos"
					>{`${nav.index} / ${nav.total}${nav.hasMore ? '+' : ''}`}</span
				>
				<Button
					icon
					size="sm"
					variant="ghost"
					aria-label="Go to older commit"
					title="Older commit"
					disabled={nav.olderOid === null}
					onclick={() => nav?.olderOid && onnavigate?.(nav.olderOid)}
					><ChevronDown size={13} /></Button
				>
			</span>
		{/if}
		<Button
			icon
			size="sm"
			variant="ghost"
			aria-label="Close commit detail"
			onclick={onclose}
			><X size={14} /></Button
		>
	</div>

	<!-- Scrollable content -->
	<div class="flex-1 overflow-y-auto min-h-0">
		<!-- Commit message -->
		<CommitMessage
			summary={commitDetail.summary}
			body={commitDetail.body}
			oid={commitDetail.oid}
		/>

		<!-- Author + parent -->
		<CommitAuthor
			authorName={commitDetail.author_name}
			authorEmail={commitDetail.author_email}
			authorTimestamp={commitDetail.author_timestamp}
			parentOids={commitDetail.parent_oids}
			childOids={nav?.childOids ?? []}
			{onnavigate}
		/>

		<!-- Commit-level notes (whole-commit, anchor === null) -->
		<CommitNotes
			notes={commitNotes}
			{repoPath}
			commitOid={commitDetail.oid}
			{reviewFilter}
			{activeReviewId}
			batchHeld={(reviewComments?.activeReview?.pending_count ?? 0) > 0}
			{editorSessionForThread}
			{editorDraftFor}
		/>

		<!-- File list -->
		<div>
			<div class="h-bar py-0 px-3 flex items-center shadow-hairline shrink-0">
				<span class="text-callout font-medium text-text flex-1">
					{`${fileDiffs.length} file${fileDiffs.length === 1 ? '' : 's'} changed`}
				</span>
				{#if totalAdds > 0 || totalDels > 0}
					<span class="inline-flex gap-2 shrink-0 mr-2 font-mono text-caption">
						{#if totalAdds > 0}
							<span class="text-diff-add">+{totalAdds}</span>
						{/if}
						{#if totalDels > 0}
							<span class="text-diff-delete">−{totalDels}</span>
						{/if}
					</span>
				{/if}
				{#if ontreeviewtoggle}
					<Button
						icon
						size="sm"
						variant="ghost"
						role="switch"
						aria-checked={treeViewEnabled}
						aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
						title={treeViewEnabled ? 'List view' : 'Tree view'}
						onclick={(e) => { e.stopPropagation(); ontreeviewtoggle?.(); }}
					>
						{#if treeViewEnabled}
							<FolderTree size={14} />
						{:else}
							<List size={14} />
						{/if}
					</Button>
				{/if}
			</div>
			<TreeFileList
				files={fileStatusList}
				treeMode={treeViewEnabled}
				actionLabel=""
				onfileaction={() => {}}
				onfileclick={(path) => onfileselect(path)}
				onfilecontextmenu={(e, _path, file) => showFileContextMenu(e, file)}
				commentCounts={fileCommentCounts}
				commentTallies={fileCommentTallies}
			/>
		</div>
	</div>
</div>

<style>
/* Click-to-copy SHA: reset the button to read as inline mono text. */

/* Toolbar pager — step to the newer/older adjacent commit in graph order. */
.pager {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	flex-shrink: 0;
}
.pager-pos {
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	font-family: var(--font-mono);
	padding: 0 var(--space-1);
}
</style>
