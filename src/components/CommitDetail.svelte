<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import Search from "@lucide/svelte/icons/search";
import X from "@lucide/svelte/icons/x";
import { copySha } from "../lib/clipboard.js";
import { fileCountsForOid, fileTalliesForOid } from "../lib/comment-counts.js";
import {
	type MessageMatch,
	messageMatches,
} from "../lib/commit-message-find.js";
import type { Draft } from "../lib/draft.svelte.js";
import { findScope } from "../lib/find-scope.js";
import {
	focusInEditable,
	keyChord,
	keyInDialog,
	onMac,
} from "../lib/keyboard.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import type { ThreadEditorSession } from "../lib/review-editors.svelte.js";
import type {
	CommitDetail,
	CommitNav,
	DiffStat,
	FileDiff,
	ReviewFilter,
	ReviewTally,
	Thread,
} from "../lib/types.js";
import Badge from "../lib/ui/Badge.svelte";
import Button from "../lib/ui/Button.svelte";
import ChangedFileList from "./ChangedFileList.svelte";
import CommitAuthor from "./CommitAuthor.svelte";
import CommitMessage from "./CommitMessage.svelte";
import CommitNotes from "./CommitNotes.svelte";
import PaneFind from "./PaneFind.svelte";

interface Props {
	commitDetail: CommitDetail;
	/** Whole-commit totals; null while they load (the bar shows the file count only). */
	stat?: DiffStat | null;
	fileDiffs: FileDiff[];
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	onclose: () => void;
	repoPath?: string;
	onhistory?: (path: string) => void;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
	nav?: CommitNav | null;
	navigationNav?: CommitNav | null;
	onnavigate?: (oid: string) => void;
	/** False while the review panel holds the center, whose J and K move between threads. */
	pagerKeys?: boolean;
	// The shared comments store, threaded from RepoView so the commit-notes block
	// reads one source of truth.
	reviewComments?: ReviewCommentsManager;
	// Which threads the commit-notes block shows.
	reviewFilter: ReviewFilter;
	commentCounts: Map<string, number>;
	commentTallies: Map<string, ReviewTally>;
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
	onhistory,
	treeViewEnabled = false,
	ontreeviewtoggle,
	nav = null,
	navigationNav = nav,
	onnavigate,
	pagerKeys = true,
	reviewComments,
	reviewFilter,
	commentCounts,
	commentTallies,
	activeReviewId = null,
	editorSessionForThread,
	editorDraftFor,
}: Props = $props();

let message = $state<CommitMessage>();
let messageFind = $state<ReturnType<typeof PaneFind<MessageMatch>>>();

function openMessageFind() {
	messageFind?.openFind();
}

// Per-file comment counts for this commit's file list, keyed by the commit's
// own OID so the badge can never disagree with what the diff pane shows for the
// same file.
let fileCommentCounts = $derived(
	fileCountsForOid(commentCounts, commitDetail.oid),
);
let fileCommentTallies = $derived(
	fileTalliesForOid(commentTallies, commitDetail.oid),
);

// j/k step older/newer through the same navigate path as the pager, so review
// flows without focusing the graph. Vim-style: j = down = older, k = up = newer.
// Arrow keys are left to CommitGraph's own (container-scoped) handler.
function handlePaneKeydown(e: KeyboardEvent) {
	if (!navigationNav || !pagerKeys) return;
	const chord = keyChord(e);
	if (chord !== "j" && chord !== "k") return;
	if (
		e.defaultPrevented ||
		keyInDialog(e) ||
		focusInEditable(document.activeElement)
	)
		return;

	const target =
		chord === "j" ? navigationNav.olderOid : navigationNav.newerOid;
	if (target === null) return;

	e.preventDefault();
	onnavigate?.(target);
}

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
	<div
		class="min-h-bar shadow-hairline py-1 px-1 flex flex-wrap items-center gap-1 shrink-0"
	>
		<span class="flex-1 flex items-center">
			<Badge title="Copy SHA" onclick={() => copySha(commitDetail.oid)}
				>{commitDetail.short_oid}</Badge
			>
		</span>
		<Button
			icon
			size="sm"
			variant="ghost"
			aria-label="Find in commit message"
			tooltip={`Find in commit message (${onMac() ? "⌘" : "Ctrl+"}F)`}
			{@attach findScope(openMessageFind)}
			onclick={openMessageFind}
			><Search size={14} /></Button
		>

		{#if nav}
			<span class="pager">
				<Button
					icon
					size="sm"
					variant="ghost"
					aria-label="Go to newer commit"
					title="Newer commit"
					disabled={!navigationNav?.newerOid}
					onclick={() =>
						navigationNav?.newerOid && onnavigate?.(navigationNav.newerOid)}
					><ChevronUp size={13} /></Button
				>
				<span class="pager-pos"
					>{`${nav.index} / ${nav.total}${nav.hasMore ? "+" : ""}`}</span
				>
				<Button
					icon
					size="sm"
					variant="ghost"
					aria-label="Go to older commit"
					title="Older commit"
					disabled={!navigationNav?.olderOid}
					onclick={() =>
						navigationNav?.olderOid && onnavigate?.(navigationNav.olderOid)}
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

	{#key commitDetail.oid}
		<PaneFind
			bind:this={messageFind}
			placeholder="Find in commit message…"
			matches={(query) =>
				messageMatches(commitDetail.summary, commitDetail.body, query)}
			onclose={() => message?.focusMessage()}
		/>
	{/key}

	<!-- Scrollable content -->
	<div class="flex-1 overflow-y-auto min-h-0">
		<!-- Commit message -->
		<CommitMessage
			bind:this={message}
			onfind={openMessageFind}
			onclosefind={() => messageFind?.closeFind() ?? false}
			match={messageFind?.currentMatch()}
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

		{#key commitDetail.oid}
			<ChangedFileList
				{fileDiffs}
				{stat}
				{selectedFile}
				{onfileselect}
				{treeViewEnabled}
				{ontreeviewtoggle}
				{repoPath}
				{onhistory}
				commentCounts={fileCommentCounts}
				commentTallies={fileCommentTallies}
			/>
		{/key}
	</div>
</div>

<style>
/* Toolbar pager — step to the newer/older adjacent commit in graph order. */
.pager {
	display: inline-flex;
	align-items: center;
	flex-shrink: 0;
}
.pager-pos {
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	font-variant-numeric: tabular-nums;
}
</style>
