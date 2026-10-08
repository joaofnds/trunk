<script lang="ts">
// One thread as a card: its state and span in the header with the actions that
// move the whole thread, the code it was left on, then every message in order,
// each carrying its own edit and delete, with the state changes between them,
// and the reply field last.

import Check from "@lucide/svelte/icons/check";
import ChevronsUp from "@lucide/svelte/icons/chevrons-up";
import Code from "@lucide/svelte/icons/code";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import Pencil from "@lucide/svelte/icons/pencil";
import StickyNote from "@lucide/svelte/icons/sticky-note";
import Trash2 from "@lucide/svelte/icons/trash-2";
import StatePill from "../../components/review/StatePill.svelte";
import ThreadEvent from "../../components/review/ThreadEvent.svelte";
import ThreadMessage from "../../components/review/ThreadMessage.svelte";
import type { ThreadState } from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import LinkButton from "../../lib/ui/LinkButton.svelte";
import RowAction from "../../lib/ui/RowAction.svelte";
import Tag from "../../lib/ui/Tag.svelte";
import Excerpt from "./Excerpt.svelte";
import FoldBar from "./FoldBar.svelte";
import {
	EXCERPT_CAP,
	EXCERPT_TAIL,
	type FileVariant,
} from "./file-variants.js";
import type { Message, Thread } from "./mock.js";

interface Props {
	thread: Thread;
	/** Where it is drawn: in the review panel, under a line of the diff, or
	 *  as the note on a file's row of the panel, which names the file itself. */
	variant?: "panel" | "inline" | "note";
	/** How a whole-file thread and a long excerpt are drawn. */
	fileVariant?: FileVariant;
	ondelete: () => void;
}

let {
	thread = $bindable(),
	variant = "panel",
	fileVariant = "tag",
	ondelete,
}: Props = $props();

const ACTIONS: Record<ThreadState, { next: ThreadState; label: string }[]> = {
	open: [
		{ next: "dismissed", label: "Dismiss" },
		{ next: "done", label: "Mark done" },
	],
	addressed: [
		{ next: "dismissed", label: "Dismiss" },
		{ next: "done", label: "Mark done" },
	],
	done: [{ next: "open", label: "Reopen" }],
	dismissed: [{ next: "open", label: "Reopen" }],
};

const settled = $derived(
	thread.state === "done" || thread.state === "dismissed",
);
let collapsedByUser = $state<boolean | null>(null);
const collapsed = $derived(collapsedByUser ?? settled);

function toggleCollapsed() {
	collapsedByUser = !collapsed;
}

let editingId = $state<string | null>(null);
let editText = $state("");
let reply = $state("");

type Entry =
	| { kind: "message"; at: number; message: Message }
	| { kind: "change"; at: number; change: Thread["history"][number] };

const entries = $derived(
	[
		...thread.messages.map(
			(message): Entry => ({ kind: "message", at: message.createdAt, message }),
		),
		...thread.history.map(
			(change): Entry => ({ kind: "change", at: change.created_at, change }),
		),
	].sort((a, b) => a.at - b.at),
);

// Today a whole-file comment is saved as a range over every line of the file,
// which is how it is drawn too.
const wholeFileAsRange = $derived(
	thread.scope.kind === "file" &&
		fileVariant === "today" &&
		thread.excerpt.length > 0,
);

const scopeLabel = $derived.by(() => {
	const scope = thread.scope;
	if (wholeFileAsRange) return `Lines 1-${thread.excerpt.length}`;
	if (scope.kind !== "lines") return null;
	return scope.start === scope.end
		? `Line ${scope.start}`
		: `Lines ${scope.start}-${scope.end}`;
});

const peek = $derived(thread.messages[0]?.text ?? "");

const hasCode = $derived(
	variant === "panel" &&
		thread.excerpt.length > 0 &&
		(thread.scope.kind === "lines" || wholeFileAsRange),
);
const caps = $derived(
	fileVariant === "capped" || fileVariant === "conversation",
);
let codeShown = $state(false);
let codeWhole = $state(false);
const codeFolded = $derived(fileVariant === "conversation" && !codeShown);
const hiddenAbove = $derived(
	caps && !codeWhole && thread.excerpt.length > EXCERPT_CAP
		? thread.excerpt.length - EXCERPT_TAIL
		: 0,
);

function moveTo(next: ThreadState) {
	thread.state = next;
	thread.history = [
		...thread.history,
		{
			state: next,
			channel: "human",
			commit: null,
			created_at: Date.now() / 1000,
		},
	];
	collapsedByUser = null;
}

function openEdit(message: Message) {
	editingId = message.id;
	editText = message.text;
}

function saveEdit() {
	const message = thread.messages.find((m) => m.id === editingId);
	if (message) message.text = editText.trim();
	editingId = null;
}

function remove(message: Message) {
	if (message === thread.messages[0]) {
		ondelete();
		return;
	}
	thread.messages = thread.messages.filter((m) => m !== message);
}

function sendReply() {
	const text = reply.trim();
	if (text === "") return;

	thread.messages = [
		...thread.messages,
		{
			id: crypto.randomUUID(),
			channel: "human",
			text,
			createdAt: Date.now() / 1000,
		},
	];
	reply = "";
}

function submitOnChord(event: KeyboardEvent, submit: () => void) {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		submit();
	}
}
</script>

<article
	class="proto-card proto-card-{variant} proto-state-{thread.state}"
	class:proto-card-settled={settled}
	class:proto-card-open={!collapsed}
>
	<header class="proto-card-header">
		<FoldBar
			noun="thread"
			inset="thread"
			{collapsed}
			ontoggle={toggleCollapsed}
		>
			<StatePill state={thread.state} />
			{#if thread.scope.kind === "commit"}
				<Tag variant="label" dashed
					><GitCommitHorizontal size={11} aria-hidden="true" />Whole commit</Tag
				>
			{:else if thread.scope.kind === "file" && !wholeFileAsRange}
				{#if variant === "note"}
					<span
						class="inline-flex items-center gap-1 text-small font-medium text-text-muted"
						><StickyNote size={12} aria-hidden="true" />Note on this file</span
					>
				{:else}
					<span class="pointer-events-auto flex">
						<Tag dashed title="Open {thread.scope.path}">Whole file</Tag>
					</span>
				{/if}
			{:else if scopeLabel}
				<Tag>{scopeLabel}</Tag>
			{/if}
			{#if thread.stale}
				<StatePill state="stale" />
			{/if}
			{#if collapsed}
				<span
					class="min-w-0 flex-1 truncate text-callout text-text-subtle"
					class:line-through={thread.state === "dismissed"}
					>{peek}</span
				>
			{:else}
				<span class="flex-1"></span>
			{/if}
			<fieldset
				class="flex min-w-auto items-center gap-1 pointer-events-auto"
				aria-label="Thread actions"
			>
				{#each ACTIONS[thread.state] as action (action.next)}
					<Button
						size="xs"
						variant={action.next === "done" ? "success" : "secondary"}
						onclick={() => moveTo(action.next)}
					>
						{#if action.next === "done"}
							<Check size={12} aria-hidden="true" />
						{/if}
						{action.label}
					</Button>
				{/each}
			</fieldset>
		</FoldBar>
	</header>

	{#if !collapsed}
		{#if hasCode && codeFolded}
			<div class="proto-code-bar flex items-center px-3 text-small">
				<LinkButton tone="muted" onclick={() => (codeShown = true)}>
					<span class="inline-flex items-center gap-1">
						<Code size={12} aria-hidden="true" />
						Show the
						{thread.excerpt.length === 1
							? "line"
							: `${thread.excerpt.length} lines`}
					</span>
				</LinkButton>
			</div>
		{:else if hasCode}
			{#if hiddenAbove > 0}
				<div class="proto-code-bar flex items-center px-3 text-small">
					<LinkButton tone="accent" onclick={() => (codeWhole = true)}>
						<span class="inline-flex items-center gap-1">
							<ChevronsUp size={12} aria-hidden="true" />
							Show {hiddenAbove} more lines above
						</span>
					</LinkButton>
				</div>
			{/if}
			<Excerpt lines={thread.excerpt.slice(hiddenAbove)} stale={thread.stale} />
		{/if}

		<ol class="m-0 list-none p-0">
			{#each entries as entry (entry.kind === "message" ? entry.message.id : `${entry.change.state}-${entry.at}`)}
				<li class="proto-entry">
					{#if entry.kind === "change"}
						<ThreadEvent change={entry.change} />
					{:else}
						{@const message = entry.message}
						<ThreadMessage
							channel={message.channel}
							createdAt={message.createdAt}
						>
							{#snippet actions()}
								{#if editingId !== message.id}
									{#if message.channel === "human"}
										<RowAction
											size="compact"
											aria-label="Edit"
											onclick={() => openEdit(message)}
										>
											<Pencil size={12} aria-hidden="true" />
										</RowAction>
									{/if}
									<RowAction
										size="compact"
										tone="destructive"
										aria-label="Delete"
										onclick={() => remove(message)}
									>
										<Trash2 size={12} aria-hidden="true" />
									</RowAction>
								{/if}
							{/snippet}
							{#if editingId === message.id}
								<div class="flex flex-col gap-2">
									<textarea
										class="proto-field"
										aria-label="Edit"
										rows="3"
										bind:value={editText}
										onkeydown={(e) => submitOnChord(e, saveEdit)}
									></textarea>
									<div class="flex justify-end gap-2">
										<Button
											size="xs"
											variant="ghost"
											onclick={() => {
												editingId = null;
											}}
											>Cancel</Button
										>
										<Button size="xs" variant="primary" onclick={saveEdit}
											>Save</Button
										>
									</div>
								</div>
							{:else}
								<p
									class="m-0 select-text text-body leading-prose"
									class:text-text-strong={thread.state !== "dismissed"}
									class:text-text-subtle={thread.state === "dismissed"}
								>
									{message.text}
								</p>
							{/if}
						</ThreadMessage>
					{/if}
				</li>
			{/each}
		</ol>

		<div class="proto-reply flex items-center gap-2 px-1 py-2">
			<textarea
				class="proto-field proto-reply-field flex-1"
				aria-label="Reply"
				placeholder="Reply…"
				rows="1"
				bind:value={reply}
				onkeydown={(e) => submitOnChord(e, sendReply)}
			></textarea>
			{#if reply.trim() !== ""}
				<Button size="xs" variant="primary" onclick={sendReply}>Reply</Button>
			{/if}
		</div>
	{/if}
</article>

<style>
.proto-card {
	display: flex;
	flex-direction: column;
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	background: var(--color-comment-card-bg);
	overflow: hidden;
	font-family: var(--font-sans);
	font-size: var(--text-callout);
}
.proto-card-header {
	height: var(--control-h);
	min-width: 0;
	background: var(--color-comment-card-header-bg);
}
.proto-card-note {
	border: 1px dashed var(--color-border-strong);
}
.proto-code-bar {
	block-size: var(--control-h);
	background: var(--color-bg);
	box-shadow: var(--shadow-hairline);
}
.proto-state-open,
.proto-state-addressed {
	border-color: var(--color-border-strong);
}
.proto-card-open .proto-card-header {
	box-shadow: var(--shadow-hairline);
}
.proto-card-settled .proto-card-header {
	background: transparent;
}
.proto-entry + .proto-entry {
	box-shadow: inset 0 1px 0 var(--color-border);
}
.proto-reply {
	box-shadow: inset 0 1px 0 var(--color-border);
}
/* Framed by a ring rather than a border, so a field of n lines stands
   a whole number of units tall. */
.proto-field {
	min-width: 0;
	resize: vertical;
	padding: var(--space-1) var(--space-2);
	border: 0;
	border-radius: var(--radius);
	box-shadow: inset 0 0 0 1px var(--color-border);
	background: var(--color-bg);
	color: var(--color-text);
	font-family: var(--font-sans);
	font-size: var(--text-body);
	line-height: var(--leading-prose);
	outline: none;
}
.proto-reply-field {
	background: transparent;
	box-shadow: none;
	resize: none;
}
.proto-reply-field:hover {
	box-shadow: inset 0 0 0 1px var(--color-border);
}
.proto-field:focus {
	box-shadow: inset 0 0 0 1px var(--color-accent);
}
</style>
