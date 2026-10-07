<script lang="ts">
// One thread as a card: its state and span in the header with the actions that
// move the whole thread, the code it was left on, then every message in order,
// each carrying its own edit and delete, with the state changes between them,
// and the reply field last.

import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import StatePill from "../../components/review/StatePill.svelte";
import ThreadEvent from "../../components/review/ThreadEvent.svelte";
import ThreadMessage from "../../components/review/ThreadMessage.svelte";
import type { ThreadState } from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import HitArea from "../../lib/ui/HitArea.svelte";
import RowAction from "../../lib/ui/RowAction.svelte";
import Tag from "../../lib/ui/Tag.svelte";
import Excerpt from "./Excerpt.svelte";
import type { Message, Thread } from "./mock.js";

interface Props {
	thread: Thread;
	/** Where it is drawn: in the review panel, or under a line of the diff. */
	variant?: "panel" | "inline";
	ondelete: () => void;
}

let { thread = $bindable(), variant = "panel", ondelete }: Props = $props();

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
const toggleLabel = $derived(collapsed ? "Expand thread" : "Collapse thread");

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

const scopeLabel = $derived.by(() => {
	const scope = thread.scope;
	if (scope.kind !== "lines") return null;
	return scope.start === scope.end
		? `Line ${scope.start}`
		: `Lines ${scope.start}-${scope.end}`;
});

const peek = $derived(thread.messages[0]?.text ?? "");

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
	class="proto-card proto-card-{variant}"
	class:proto-card-settled={settled}
	class:proto-card-open={!collapsed}
>
	<header class="proto-card-header">
		<HitArea
			cursor="pointer"
			aria-label={toggleLabel}
			aria-expanded={!collapsed}
			onclick={toggleCollapsed}
		/>
		<div class="proto-card-header-content">
			<span class="flex pointer-events-auto">
				<Button
					icon
					size="xs"
					variant="ghost"
					aria-expanded={!collapsed}
					aria-label={toggleLabel}
					onclick={toggleCollapsed}
				>
					{#if collapsed}
						<ChevronRight size={12} aria-hidden="true" />
					{:else}
						<ChevronDown size={12} aria-hidden="true" />
					{/if}
				</Button>
			</span>
			<StatePill state={thread.state} />
			{#if thread.scope.kind === "commit"}
				<Tag variant="label" dashed
					><GitCommitHorizontal size={11} aria-hidden="true" />Whole commit</Tag
				>
			{:else if thread.scope.kind === "file"}
				<Tag variant="label" dashed>Whole file</Tag>
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
		</div>
	</header>

	{#if !collapsed}
		{#if thread.excerpt.length > 0 && variant === "panel"}
			<Excerpt lines={thread.excerpt} dim={thread.stale}>
				{#if thread.stale}
					Saved excerpt. These lines have moved or changed since.
				{/if}
			</Excerpt>
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
											size="sm"
											variant="ghost"
											onclick={() => {
												editingId = null;
											}}
											>Cancel</Button
										>
										<Button size="sm" variant="primary" onclick={saveEdit}
											>Save</Button
										>
									</div>
								</div>
							{:else}
								<p
									class="m-0 select-text leading-normal"
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

		<div class="proto-reply flex items-end gap-2 p-2">
			<textarea
				class="proto-field flex-1"
				aria-label="Reply"
				placeholder="Reply…"
				rows="1"
				bind:value={reply}
				onkeydown={(e) => submitOnChord(e, sendReply)}
			></textarea>
			{#if reply.trim() !== ""}
				<Button size="sm" variant="primary" onclick={sendReply}>Reply</Button>
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
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	height: var(--control-h);
	min-width: 0;
	background: var(--color-comment-card-header-bg);
}
.proto-card-header > :global(*) {
	grid-area: 1 / 1;
	min-width: 0;
}
.proto-card-header-content {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0 var(--space-1);
	pointer-events: none;
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
.proto-field {
	min-width: 0;
	resize: vertical;
	padding: var(--space-1) var(--space-2);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	background: var(--color-bg);
	color: var(--color-text);
	font-family: var(--font-sans);
	font-size: var(--text-callout);
	line-height: var(--leading-normal);
	outline: none;
}
.proto-field:focus {
	border-color: var(--color-accent);
}
</style>
