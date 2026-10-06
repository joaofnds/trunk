<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import Sortable from "sortablejs";
import { copyRefName, copySha } from "../lib/clipboard.js";
import { exactDate } from "../lib/exact-date.js";
import { COLUMN_PADDING_X } from "../lib/graph-constants.js";
import { safeInvoke } from "../lib/invoke.js";
import { currentMinute } from "../lib/now.svelte.js";
import { validateRebasePlan } from "../lib/rebase-validation.js";
import { relativeLabel } from "../lib/relative-time.js";
import type {
	RebaseColumnVisibility,
	RebaseColumnWidths,
} from "../lib/store.js";
import {
	getRebaseColumnVisibility,
	getRebaseColumnWidths,
	setRebaseColumnVisibility,
	setRebaseColumnWidths,
} from "../lib/store.js";
import { measureTextWidth } from "../lib/text-measure.js";
import type { RebaseBase, RebaseTodoItem } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Chip from "../lib/ui/Chip.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Splitter from "../lib/ui/Splitter.svelte";

type RebaseAction = "pick" | "squash" | "reword" | "drop";

interface RebaseCommit {
	oid: string;
	shortOid: string;
	summary: string;
	authorName: string;
	authorTimestamp: number;
	action: RebaseAction;
	newMessage: string | null;
}

interface Props {
	repoPath: string;
	commits: RebaseTodoItem[];
	branchName: string;
	base: RebaseBase;
	onclose: () => void;
	onstart: (
		items: {
			oid: string;
			action: string;
			summary: string;
			newMessage: string | null;
		}[],
	) => void;
	onfocuschange?: (oid: string) => void;
}

let {
	repoPath,
	commits,
	branchName,
	base,
	onclose,
	onstart,
	onfocuschange,
}: Props = $props();

function toRebaseCommits(source: RebaseTodoItem[]): RebaseCommit[] {
	// Reverse: backend sends oldest-first (for git), but we display newest-first (like the graph)
	return [...source].reverse().map((c) => ({
		oid: c.oid,
		shortOid: c.short_oid,
		summary: c.summary,
		authorName: c.author_name,
		authorTimestamp: c.author_timestamp,
		action: "pick" as RebaseAction,
		newMessage: null,
	}));
}

let items = $state<RebaseCommit[]>([]);
let originalItems = $state<RebaseCommit[]>([]);

// Initialize and reinitialize when the commits prop changes
$effect(() => {
	items = toRebaseCommits(commits);
	originalItems = structuredClone(toRebaseCommits(commits));
});

let focusedIndex = $state<number>(0);
let editorEl: HTMLDivElement | undefined = $state();
let headerEl: HTMLDivElement | undefined = $state();
const uid = $props.id();
const messageEditorId = `${uid}-message-editor`;
let listEl: HTMLDivElement | undefined = $state();

// Inline message editor state
let editingIdx = $state<number | null>(null);
let editingSummary = $state("");
let editingBody = $state("");
let columnWidths = $state<RebaseColumnWidths>({
	sha: 80,
	author: 120,
	date: 100,
});
let columnVisibility = $state<RebaseColumnVisibility>({
	sha: true,
	author: true,
	date: true,
});

// Validate in git order (oldest-first = reversed display), remap indices back to display order
let validationErrors = $derived.by(() => {
	const gitOrder = [...items].reverse();
	const errors = validateRebasePlan(gitOrder);
	const lastIdx = items.length - 1;
	return errors.map((e) => ({ ...e, index: lastIdx - e.index }));
});
let hasChanges = $derived(
	JSON.stringify(items) !== JSON.stringify(originalItems),
);
let canStart = $derived(validationErrors.length === 0);
const nowMinute = $derived(currentMinute());

// Emit focus change when focused commit changes
$effect(() => {
	if (items[focusedIndex]) onfocuschange?.(items[focusedIndex].oid);
});

// Load persisted column state on mount
$effect(() => {
	getRebaseColumnWidths().then((w) => (columnWidths = w));
	getRebaseColumnVisibility().then((v) => (columnVisibility = v));
});

// --- Helpers ---

function actionColor(action: string): string {
	switch (action) {
		case "pick":
			return "var(--color-success)";
		case "reword":
			return "var(--color-warning)";
		case "squash":
			return "var(--color-accent-alt)";
		case "drop":
			return "var(--color-danger)";
		default:
			return "var(--color-text-muted)";
	}
}

function errorForIndex(idx: number): string | null {
	const err = validationErrors.find((e) => e.index === idx);
	return err ? err.message : null;
}

// --- Column resize ---

const HEADER_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const HEADER_PAD = 4 * COLUMN_PADDING_X;
const headerMinSha = measureTextWidth("SHA", HEADER_FONT) + HEADER_PAD;
const headerMinAuthor = measureTextWidth("Author", HEADER_FONT) + HEADER_PAD;
const headerMinDate = measureTextWidth("Date", HEADER_FONT) + HEADER_PAD;

const MIN_WIDTHS: RebaseColumnWidths = {
	sha: headerMinSha,
	author: headerMinAuthor,
	date: headerMinDate,
};
const MAX_WIDTHS: RebaseColumnWidths = { sha: 120, author: 400, date: 400 };

function resizeColumn(column: keyof RebaseColumnWidths, width: number) {
	const clamped = Math.max(
		MIN_WIDTHS[column],
		Math.min(MAX_WIDTHS[column], width),
	);
	columnWidths = { ...columnWidths, [column]: clamped };
}

function startColumnResize(column: keyof RebaseColumnWidths, e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startWidth = columnWidths[column];

	function onMouseMove(ev: MouseEvent) {
		resizeColumn(column, startWidth - (ev.clientX - startX));
	}

	function onMouseUp() {
		setRebaseColumnWidths(columnWidths);
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}

function stepColumn(column: keyof RebaseColumnWidths, delta: number) {
	const before = columnWidths[column];
	resizeColumn(column, before - delta);

	if (columnWidths[column] !== before) setRebaseColumnWidths(columnWidths);
}

// --- Header context menu ---

function openMenuIfOnHeader(e: MouseEvent) {
	if (!(e.target instanceof Node) || !headerEl?.contains(e.target)) return;

	void showHeaderContextMenu(e);
}

async function showHeaderContextMenu(e: MouseEvent) {
	e.preventDefault();
	const cols: { key: keyof RebaseColumnVisibility; label: string }[] = [
		{ key: "sha", label: "SHA" },
		{ key: "author", label: "Author" },
		{ key: "date", label: "Date" },
	];
	const menuItems = await Promise.all(
		cols.map((col) =>
			CheckMenuItem.new({
				text: col.label,
				checked: columnVisibility[col.key],
				action: () => {
					columnVisibility = {
						...columnVisibility,
						[col.key]: !columnVisibility[col.key],
					};
					setRebaseColumnVisibility(columnVisibility);
				},
			}),
		),
	);
	const menu = await Menu.new({ items: menuItems });
	await menu.popup();
}

// --- Drag-and-drop (SortableJS) ---

$effect(() => {
	if (!listEl) return;
	const sortable = Sortable.create(listEl, {
		animation: 150,
		forceFallback: true,
		ghostClass: "rebase-row-ghost",
		chosenClass: "rebase-row-chosen",
		dragClass: "rebase-row-drag",
		fallbackClass: "rebase-row-fallback",
		filter: "select, option",
		preventOnFilter: false,
		onStart: (e) => {
			if (e.oldIndex != null) focusedIndex = e.oldIndex;
		},
		onEnd: (e) => {
			if (e.oldIndex == null || e.newIndex == null || e.oldIndex === e.newIndex)
				return;
			// Update state — {#key items} forces full DOM recreation so no conflict
			const updated = [...items];
			const [moved] = updated.splice(e.oldIndex, 1);
			updated.splice(e.newIndex, 0, moved);
			items = updated;
			focusedIndex = e.newIndex;
		},
	});
	return () => sortable.destroy();
});

// --- Keyboard shortcuts ---

function scrollRowIntoView(idx: number) {
	const row = listEl?.querySelector(`[data-rebase-row="${idx}"]`);
	row?.scrollIntoView({ block: "nearest" });
}

function handleEditorKeydown(e: KeyboardEvent) {
	if (!(e.target instanceof Element) || !editorEl?.contains(e.target)) return;

	if (e.target.closest(`#${CSS.escape(messageEditorId)}`)) {
		e.stopPropagation();
		if (e.key === "Escape") handleMessageCancel();
		return;
	}

	const tag = e.target.tagName;
	if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;

	switch (e.key) {
		case "p":
		case "P":
			e.preventDefault();
			items[focusedIndex].action = "pick";
			if (focusedIndex < items.length - 1) {
				focusedIndex += 1;
				scrollRowIntoView(focusedIndex);
			}
			break;
		case "s":
		case "S":
			e.preventDefault();
			items[focusedIndex].action = "squash";
			if (focusedIndex < items.length - 1) {
				focusedIndex += 1;
				scrollRowIntoView(focusedIndex);
			}
			break;
		case "r":
		case "R":
			e.preventDefault();
			items[focusedIndex].action = "reword";
			openMessageEditor(focusedIndex);
			break;
		case "d":
		case "D":
			e.preventDefault();
			items[focusedIndex].action = "drop";
			if (focusedIndex < items.length - 1) {
				focusedIndex += 1;
				scrollRowIntoView(focusedIndex);
			}
			break;
		case "ArrowUp":
			e.preventDefault();
			if (e.shiftKey && focusedIndex > 0) {
				const updated = [...items];
				[updated[focusedIndex - 1], updated[focusedIndex]] = [
					updated[focusedIndex],
					updated[focusedIndex - 1],
				];
				items = updated;
				focusedIndex -= 1;
			} else if (!e.shiftKey) {
				focusedIndex = Math.max(0, focusedIndex - 1);
			}
			scrollRowIntoView(focusedIndex);
			break;
		case "ArrowDown":
			e.preventDefault();
			if (e.shiftKey && focusedIndex < items.length - 1) {
				const updated = [...items];
				[updated[focusedIndex], updated[focusedIndex + 1]] = [
					updated[focusedIndex + 1],
					updated[focusedIndex],
				];
				items = updated;
				focusedIndex += 1;
			} else if (!e.shiftKey) {
				focusedIndex = Math.min(items.length - 1, focusedIndex + 1);
			}
			scrollRowIntoView(focusedIndex);
			break;
		case "Escape":
			if (editingIdx !== null) {
				e.preventDefault();
				handleMessageCancel();
			}
			break;
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}

function selectAll(node: HTMLInputElement) {
	requestAnimationFrame(() => {
		node.focus();
		node.select();
	});
}

// --- Inline message editor ---

async function openMessageEditor(idx: number) {
	const item = items[idx];
	if (item.action === "drop") return;
	focusedIndex = idx;

	if (item.action === "squash") {
		// Find predecessor: in display order (newest-first), predecessor is at idx + 1
		const predIdx = idx + 1;
		if (predIdx >= items.length) return; // shouldn't happen (validation prevents)
		const pred = items[predIdx];

		if (item.newMessage != null) {
			// Already edited — reuse stored combined message
			const lines = item.newMessage.split("\n");
			editingSummary = lines[0] ?? "";
			editingBody = lines.slice(1).join("\n").replace(/^\n/, "");
		} else {
			// Fetch full messages for both predecessor and squash commit
			try {
				const [predDetail, squashDetail] = await Promise.all([
					safeInvoke<{ summary: string; body: string | null }>(
						"get_commit_detail",
						{
							path: repoPath,
							oid: pred.oid,
						},
					),
					safeInvoke<{ summary: string; body: string | null }>(
						"get_commit_detail",
						{
							path: repoPath,
							oid: item.oid,
						},
					),
				]);
				const predMsg = predDetail.body
					? `${predDetail.summary}\n\n${predDetail.body}`
					: predDetail.summary;
				const squashMsg = squashDetail.body
					? `${squashDetail.summary}\n\n${squashDetail.body}`
					: squashDetail.summary;
				const combined = `${predMsg}\n\n${squashMsg}`;
				const lines = combined.split("\n");
				editingSummary = lines[0] ?? "";
				editingBody = lines.slice(1).join("\n").replace(/^\n/, "");
			} catch {
				editingSummary = `${pred.summary}\n\n${item.summary}`;
				editingBody = "";
			}
		}
		editingIdx = idx;
		return;
	}

	if (item.newMessage != null) {
		// Already edited — split summary/body from stored message
		const lines = item.newMessage.split("\n");
		editingSummary = lines[0] ?? "";
		editingBody = lines.slice(1).join("\n").replace(/^\n/, "");
	} else {
		// Fetch full commit message
		editingSummary = item.summary;
		try {
			const detail = await safeInvoke<{ summary: string; body: string | null }>(
				"get_commit_detail",
				{
					path: repoPath,
					oid: item.oid,
				},
			);
			editingSummary = detail.summary;
			editingBody = detail.body ?? "";
		} catch {
			editingBody = "";
		}
	}

	editingIdx = idx;
	// Auto-set to reword if currently pick
	if (item.action === "pick") item.action = "reword";
}

function handleMessageUpdate() {
	if (editingIdx === null) return;
	const fullMsg = editingBody.trim()
		? `${editingSummary.trim()}\n\n${editingBody.trim()}`
		: editingSummary.trim();
	items[editingIdx].newMessage = fullMsg;
	// Update displayed summary to match
	items[editingIdx].summary = editingSummary.trim();
	editingIdx = null;
}

function handleMessageCancel() {
	editingIdx = null;
}

// --- Toolbar handlers ---

function handleReset() {
	items = toRebaseCommits(commits);
	focusedIndex = 0;
}

function handleCancel() {
	onclose();
}

function handleStartRebase() {
	if (!canStart) return;
	// Reverse back to oldest-first for git's rebase todo
	const reversed = [...items].reverse();
	onstart(
		reversed.map((i) => ({
			oid: i.oid,
			action: i.action,
			summary: i.summary,
			newMessage: i.newMessage,
		})),
	);
}

// Determine last visible resizable column for resize handle logic
let lastVisibleColumn = $derived.by(() => {
	if (columnVisibility.date) return "date";
	if (columnVisibility.author) return "author";
	if (columnVisibility.sha) return "sha";
	return "message";
});
</script>

<svelte:document
	onkeydown={handleEditorKeydown}
	oncontextmenu={openMenuIfOnHeader}
/>

{#snippet edgeBefore(column: keyof RebaseColumnWidths, label: string)}
	<Splitter
		variant="column"
		aria-label="Resize {label} column"
		value={columnWidths[column]}
		min={MIN_WIDTHS[column]}
		max={MAX_WIDTHS[column]}
		onstep={(delta) => stepColumn(column, delta)}
		onmousedown={(e) => startColumnResize(column, e)}
	/>
{/snippet}

<div
	class="rebase-editor"
	tabindex="-1"
	aria-owns={editingIdx === null ? undefined : messageEditorId}
	bind:this={editorEl}
	use:autofocus
>
	<!-- Header -->
	<div class="rebase-toolbar">
		<div class="rebase-toolbar-left">
			<span class="rebase-toolbar-title">Interactive Rebase</span>
			<span class="rebase-toolbar-meta"
				>Rebasing
				<Chip title="Copy {branchName}" onclick={() => copyRefName(branchName)}
					><GitBranch size={11} />{branchName}</Chip
				>
				onto
				{#if base.kind === "branch"}
					<Chip title="Copy {base.name}" onclick={() => copyRefName(base.name)}
						><GitBranch size={11} />{base.name}</Chip
					>
				{:else if base.kind === "commit"}
					<Chip title="Copy SHA" onclick={() => copySha(base.oid)}
						><GitCommitHorizontal size={11} />{base.oid.slice(0, 7)}</Chip
					>
				{:else}
					<Chip variant="label">root</Chip>
				{/if}</span
			>
		</div>
		<div class="rebase-toolbar-right">
			<Button size="sm" disabled={!hasChanges} onclick={handleReset}
				>Reset</Button
			>
		</div>
	</div>

	<!-- Column header -->
	<div class="rebase-header" bind:this={headerEl}>
		<div class="rebase-col-action" style:padding="0 {COLUMN_PADDING_X}px">
			Action
		</div>
		<div class="flex-1 relative" style:padding="0 {COLUMN_PADDING_X}px">
			Message
			{#if 'message' !== lastVisibleColumn}
				{@render edgeBefore('sha', 'SHA')}
			{/if}
		</div>
		{#if columnVisibility.sha}
			<div
				class="flex-shrink-0 relative"
				style:width="{columnWidths.sha}px"
				style:padding="0 {COLUMN_PADDING_X}px"
			>
				SHA
				{#if 'sha' !== lastVisibleColumn}
					{@render edgeBefore('author', 'Author')}
				{/if}
			</div>
		{/if}
		{#if columnVisibility.author}
			<div
				class="flex-shrink-0 relative"
				style:width="{columnWidths.author}px"
				style:padding="0 {COLUMN_PADDING_X}px"
			>
				Author
				{#if 'author' !== lastVisibleColumn}
					{@render edgeBefore('date', 'Date')}
				{/if}
			</div>
		{/if}
		{#if columnVisibility.date}
			<div
				class="flex-shrink-0 relative"
				style:width="{columnWidths.date}px"
				style:padding="0 {COLUMN_PADDING_X}px"
			>
				Date
			</div>
		{/if}
	</div>

	<!-- Commit list: {#key} forces DOM recreation after reorder so SortableJS and Svelte don't fight -->
	{#key items}
		<div
			class="rebase-list"
			role="listbox"
			aria-label="Commits to rebase"
			bind:this={listEl}
		>
			{#each items as item, idx (item.oid)}
				<div class="rebase-row-wrapper">
					<div
						class="rebase-row h-row"
						role="option"
						aria-selected={focusedIndex === idx}
						aria-describedby={errorForIndex(idx) ? `${uid}-error-${idx}` : undefined}
						tabindex="0"
						class:rebase-row-focused={focusedIndex === idx}
						class:rebase-row-drop={item.action === 'drop'}
						class:rebase-row-squash={item.action === 'squash'}
						data-rebase-row={idx}
						onclick={() => (focusedIndex = idx)}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (item.action !== 'drop') openMessageEditor(idx); } else if (e.key === ' ') { e.preventDefault(); focusedIndex = idx; } }}
						ondblclick={() => { if (item.action !== 'drop') openMessageEditor(idx); }}
					>
						{#if item.action === 'squash'}
							<span class="rebase-squash-arrow">↓</span>
						{/if}
						<!-- Action column -->
						<div
							class="rebase-cell-action"
							style:padding="0 {COLUMN_PADDING_X}px"
						>
							<span
								class="rebase-action-dot"
								style:background={actionColor(item.action)}
							></span>
							<select
								class="rebase-select"
								bind:value={item.action}
								onclick={(e) => e.stopPropagation()}
								onchange={() => { if (item.action === 'reword' || item.action === 'squash') openMessageEditor(idx); }}
							>
								<option value="pick">Pick</option>
								<option value="reword">Reword</option>
								<option value="squash">Squash</option>
								<option value="drop">Drop</option>
							</select>
						</div>

						<!-- Message column -->
						<div
							class="rebase-cell rebase-cell-message flex-1"
							style:padding="0 {COLUMN_PADDING_X}px"
						>
							<span class:rebase-text-drop={item.action === 'drop'}
								>{item.newMessage ?? item.summary}</span
							>
						</div>

						<!-- SHA column -->
						{#if columnVisibility.sha}
							<div
								class="rebase-cell flex-shrink-0"
								style:width="{columnWidths.sha}px"
								style:padding="0 {COLUMN_PADDING_X}px"
							>
								<LinkButton
									mono
									truncate
									title="Copy SHA"
									onclick={(e) => { e.stopPropagation(); copySha(item.oid); }}
									onkeydown={(e) => e.stopPropagation()}
									ondblclick={(e) => e.stopPropagation()}
									>{item.shortOid}</LinkButton
								>
							</div>
						{/if}

						<!-- Author column -->
						{#if columnVisibility.author}
							<div
								class="rebase-cell flex-shrink-0"
								style:width="{columnWidths.author}px"
								style:padding="0 {COLUMN_PADDING_X}px"
							>
								<span class:rebase-text-drop={item.action === 'drop'}
									>{item.authorName}</span
								>
							</div>
						{/if}

						<!-- Date column -->
						{#if columnVisibility.date}
							<div
								class="rebase-cell flex-shrink-0 rebase-cell-date"
								style:width="{columnWidths.date}px"
								style:padding="0 {COLUMN_PADDING_X}px"
							>
								<span
									class:rebase-text-drop={item.action === 'drop'}
									use:exactDate={item.authorTimestamp}
									>{relativeLabel(item.authorTimestamp, nowMinute)}</span
								>
							</div>
						{/if}
					</div>

					<!-- Validation error inline -->
					{#if errorForIndex(idx)}
						<div
							class="rebase-validation-error"
							id="{uid}-error-{idx}"
							aria-hidden="true"
						>
							{errorForIndex(idx)}
						</div>
					{/if}

					<!-- Floating message editor (absolute, doesn't push rows) -->
					{#if editingIdx === idx}
						<div class="rebase-msg-anchor">
							<Dialog
								variant="anchored"
								id={messageEditorId}
								tabindex={-1}
								title={items[editingIdx]?.action === 'squash' ? 'Edit squash message' : 'Reword commit message'}
							>
								<input
									class="rebase-msg-editor-summary"
									type="text"
									tabindex="0"
									placeholder="Summary (required)"
									bind:value={editingSummary}
									use:selectAll
								>
								<textarea
									class="rebase-msg-editor-body"
									placeholder="Body (optional)"
									tabindex="0"
									rows="4"
									bind:value={editingBody}
								></textarea>
								<div class="rebase-msg-editor-buttons">
									<Button
										size="sm"
										variant="success"
										onclick={handleMessageUpdate}
										>Update Message</Button
									>
									<Button size="sm" onclick={handleMessageCancel}
										>Cancel</Button
									>
								</div>
							</Dialog>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/key}

	<!-- Bottom bar -->
	<div class="rebase-bottombar">
		<div class="rebase-shortcuts">
			<span class="rebase-shortcut-label">shortcuts:</span>
			<span class="rebase-shortcut-key">P</span>
			Pick
			<span class="rebase-shortcut-key">S</span>
			Squash
			<span class="rebase-shortcut-key">R</span>
			Reword
			<span class="rebase-shortcut-key">D</span>
			Drop
			<span class="rebase-shortcut-key">Shift+↑</span>
			Move Up
			<span class="rebase-shortcut-key">Shift+↓</span>
			Move Down
		</div>
		<div class="rebase-bottombar-right">
			<Button size="sm" variant="danger" onclick={handleCancel}
				>Cancel Rebase</Button
			>
			<Button
				size="sm"
				variant="success"
				disabled={!canStart}
				onclick={handleStartRebase}
				>Start Rebase</Button
			>
		</div>
	</div>
</div>

<style>
.rebase-editor {
	display: flex;
	flex-direction: column;
	height: 100%;
	background: var(--color-bg);
	outline: none;
}

/* --- Toolbar --- */

.rebase-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: var(--bar-h);
	flex-shrink: 0;
	background: var(--color-surface);
	box-shadow: inset 0 -1px 0 var(--color-border);
	padding: 0 var(--space-3);
}

.rebase-toolbar-left {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.rebase-toolbar-title {
	font-size: var(--text-body);
	font-weight: var(--weight-semibold);
	color: var(--color-text);
}

.rebase-toolbar-meta {
	font-size: var(--text-callout);
	color: var(--color-text-muted);
}

.rebase-toolbar-right {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.rebase-bottombar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-shrink: 0;
	padding: var(--space-2) var(--space-3);
	border-top: 1px solid var(--color-border);
	background: var(--color-surface);
}

.rebase-shortcuts {
	font-size: var(--text-small);
	color: var(--color-text-muted);
	display: flex;
	align-items: center;
	gap: var(--space-1);
	flex-wrap: wrap;
}

.rebase-shortcut-label {
	font-weight: var(--weight-semibold);
	margin-right: var(--space-1);
}

.rebase-shortcut-key {
	background: var(--color-bg);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	padding: 0 var(--space-1);
	font-family: var(--font-mono);
	font-size: var(--text-caption);
	margin-left: var(--space-2);
}

.rebase-bottombar-right {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

/* --- Column header --- */

.rebase-header {
	display: flex;
	align-items: center;
	height: var(--bar-h);
	flex-shrink: 0;
	background: var(--color-surface);
	box-shadow: inset 0 -1px 0 var(--color-border);
	font-size: var(--text-small);
	color: var(--color-text-muted);
}

.rebase-col-action {
	flex-shrink: 0;
}

/* --- Commit list --- */

.rebase-list {
	flex: 1;
	overflow-y: auto;
}

.rebase-row {
	position: relative;
	display: flex;
	align-items: center;
	font-size: var(--text-body);
	color: var(--color-text);
	cursor: grab;
}

.rebase-row:hover:not(.rebase-row-focused) {
	background: var(--color-surface);
}

.rebase-row-focused {
	border-left: 2px solid var(--color-accent);
	background: var(--color-selected-row);
}

.rebase-row-drop {
	opacity: var(--opacity-dimmed);
}

.rebase-row-squash {
	padding-left: var(--space-4);
	border-left: 2px solid var(--color-accent-alt);
}

.rebase-row-squash.rebase-row-focused {
	border-left: 2px solid var(--color-accent-alt);
}

.rebase-squash-arrow {
	position: absolute;
	left: calc(3 * var(--u) / 4);
	top: 50%;
	transform: translateY(-50%);
	font-size: var(--text-callout);
	color: var(--color-accent-alt);
	z-index: 1;
	pointer-events: none;
}

:global(.rebase-row-ghost) {
	opacity: 0.4;
}

:global(.rebase-row-chosen) {
	background: var(--color-selected-row);
}

:global(.rebase-row-drag) {
	opacity: 0;
}

:global(.rebase-row-fallback) {
	background: var(--color-surface);
	box-shadow: var(--shadow-sm);
	opacity: 0.9;
}

.rebase-text-drop {
	text-decoration: line-through;
}

/* --- Cells --- */

.rebase-cell-action {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	gap: var(--space-1);
}

.rebase-action-dot {
	display: inline-block;
	width: calc(3 * var(--u) / 2);
	height: calc(3 * var(--u) / 2);
	border-radius: 50%;
	vertical-align: middle;
	flex-shrink: 0;
}

.rebase-select {
	background: var(--color-bg);
	border: 1px solid var(--color-border);
	color: var(--color-text);
	font-size: var(--text-small);
	padding: var(--space-1);
	border-radius: var(--radius);
	cursor: pointer;
	font-family: var(--font-sans);
}

.rebase-cell {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Click-to-copy SHA: reset the button to read as the plain mono cell text. */
.rebase-cell-message {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.rebase-cell-date {
	color: var(--color-text-muted);
}

/* --- Inline message editor --- */

.rebase-row-wrapper {
	position: relative;
}

.rebase-msg-anchor {
	position: absolute;
	top: 100%;
	left: calc(12 * var(--u));
	right: calc(12 * var(--u));
	z-index: 10;
}

.rebase-msg-editor-summary {
	background: var(--color-bg);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	color: var(--color-text);
	font-size: var(--text-body);
	font-family: var(--font-sans);
	padding: var(--space-2);
	outline: none;
}

.rebase-msg-editor-summary:focus {
	border-color: var(--color-accent);
}

.rebase-msg-editor-body {
	background: var(--color-bg);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	color: var(--color-text);
	font-size: var(--text-body);
	font-family: var(--font-sans);
	padding: var(--space-2);
	resize: vertical;
	outline: none;
}

.rebase-msg-editor-body:focus {
	border-color: var(--color-accent);
}

.rebase-msg-editor-buttons {
	display: flex;
	justify-content: flex-end;
	gap: var(--space-2);
}

/* --- Validation error --- */

.rebase-validation-error {
	background: var(--color-danger-bg-subtle);
	padding: var(--space-1) var(--space-3);
	font-size: var(--text-small);
	color: var(--color-danger);
}

.rebase-col-action,
.rebase-cell-action {
	width: calc(45 * var(--u) / 2);
}
</style>
