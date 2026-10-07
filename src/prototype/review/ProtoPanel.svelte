<script lang="ts">
// The review panel: the shown review's name and actions over a tally of its
// threads, then its threads by branch, by commit and by file, and the keys
// that move between them at the foot.

import Archive from "@lucide/svelte/icons/archive";
import Copy from "@lucide/svelte/icons/copy";
import File from "@lucide/svelte/icons/file";
import StateGlyph from "../../components/review/StateGlyph.svelte";
import StatePill from "../../components/review/StatePill.svelte";
import { laneColor } from "../../lib/lanes.js";
import type { ThreadState } from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import ButtonGroup from "../../lib/ui/ButtonGroup.svelte";
import Chip from "../../lib/ui/Chip.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";
import LinkButton from "../../lib/ui/LinkButton.svelte";
import Radio from "../../lib/ui/Radio.svelte";
import FoldBar from "./FoldBar.svelte";
import type { Group, Review, Thread } from "./mock.js";
import ProtoThread from "./ProtoThread.svelte";

interface Props {
	review: Review;
	active: boolean;
}

let { review = $bindable(), active }: Props = $props();

const TALLY = [
	{ state: "open", label: "Open", tone: "text-thread-open" },
	{ state: "addressed", label: "Addressed", tone: "text-thread-addressed" },
	{ state: "done", label: "Done", tone: "text-thread-done" },
	{ state: "dismissed", label: "Dismissed", tone: "text-thread-dismissed" },
] as const;

const STATES: readonly ThreadState[] = TALLY.map((tally) => tally.state);

const KEYS: [string[], string][] = [
	[["J", "K"], "move"],
	[["↵"], "open code"],
	[["R"], "reply"],
	[["D"], "done"],
	[["X"], "dismiss"],
	[["O"], "reopen"],
];

const VIEW_IDS = ["all", "needs", "settled"] as const;
type ViewId = (typeof VIEW_IDS)[number];

const VIEWS: Record<ViewId, { label: string; states: readonly ThreadState[] }> =
	{
		all: { label: "All", states: STATES },
		needs: { label: "Needs me", states: ["open", "addressed"] },
		settled: { label: "Settled", states: ["done", "dismissed"] },
	};

let shown = $state<Record<ThreadState, boolean>>({
	open: true,
	addressed: true,
	done: true,
	dismissed: true,
});
let showStale = $state(true);

const threads = $derived(
	review.sections.flatMap((s) => s.groups.flatMap((g) => g.threads)),
);
const staleCount = $derived(threads.filter((t) => t.stale).length);
const hiddenCount = $derived(threads.length - threads.filter(matches).length);
const activeView = $derived(
	VIEW_IDS.find(
		(id) =>
			showStale &&
			STATES.every(
				(state) => shown[state] === VIEWS[id].states.includes(state),
			),
	),
);

function matches(thread: Thread): boolean {
	return shown[thread.state] && (showStale || !thread.stale);
}

function pick(id: ViewId) {
	for (const state of STATES) shown[state] = VIEWS[id].states.includes(state);
	showStale = true;
}

function visible(group: Group): Thread[] {
	return group.threads.filter(matches);
}

function byFile(group: Group): { path: string | null; threads: Thread[] }[] {
	const files = new Map<string | null, Thread[]>();
	for (const thread of visible(group)) {
		const path = thread.scope.kind === "commit" ? null : thread.scope.path;
		files.set(path, [...(files.get(path) ?? []), thread]);
	}
	return [...files].map(([path, threads]) => ({ path, threads }));
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

let folded = $state<Record<string, boolean>>({});

function fileKey(group: Group, path: string): string {
	return `${group.key}:${path}`;
}

function toggleFold(key: string) {
	folded[key] = !folded[key];
}

function removeThread(group: Group, thread: Thread) {
	group.threads = group.threads.filter((t) => t !== thread);
}
</script>

{#snippet toggle(
label: string,
glyph: ThreadState | "stale",
tone: string,
count: number,
on: boolean,
ontoggle: () => void,
)}
	<LinkButton
		tone="muted"
		aria-pressed={on}
		aria-label={label}
		title={on ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
		onclick={ontoggle}
	>
		<span
			class="inline-flex items-center gap-1 font-mono"
			class:line-through={!on}
		>
			<span
				class="inline-flex {on ? tone : 'text-text-disabled'}"
				aria-hidden="true"
			>
				<StateGlyph state={glyph} size={11} />
			</span>
			{count}
		</span>
	</LinkButton>
{/snippet}

<section
	aria-label="Review threads"
	class="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
>
	<header class="flex shrink-0 flex-col gap-2 px-4 py-3 shadow-hairline">
		<div class="flex flex-wrap items-center gap-2">
			<h1
				class="m-0 min-w-0 truncate text-title font-semibold text-text-strong"
			>
				{review.title}
			</h1>
			<span
				class="inline-flex h-control-xs shrink-0 items-center rounded bg-surface-chip px-1 font-mono text-caption font-medium text-text"
				>{review.id}</span
			>
			<StatePill review={review.state} />
			<span class="flex-1"></span>
			<Button size="sm"><File size={12} />Comment on a file…</Button>
			<Button size="sm"><Copy size={12} />Copy</Button>
			<Button size="sm"><Archive size={12} />Archive</Button>
		</div>
		<div
			class="flex min-w-0 items-center gap-2 whitespace-nowrap text-small text-text-subtle"
		>
			{#if active}
				<span
					class="inline-flex items-center gap-1 font-medium text-accent-strong"
				>
					<Radio variant="mark" checked />
					Active
				</span>
			{:else}
				<Button size="xs">Make active</Button>
			{/if}
			<span class="text-text-disabled" aria-hidden="true">·</span>
			<span
				>{review.visibleToAgent
					? "Visible to the agent"
					: "Not visible to the agent"}</span
			>
			{#if threads.length > 0}
				<span class="text-text-disabled" aria-hidden="true">·</span>
				<ul
					class="m-0 flex list-none gap-3 p-0"
					aria-label="Show threads by state"
				>
					{#each TALLY as tally (tally.state)}
						{@const count = threads.filter((t) => t.state === tally.state).length}
						{#if count > 0}
							<li class="inline-flex">
								{@render toggle(
`${tally.label} threads`,
tally.state,
tally.tone,
count,
shown[tally.state],
() => (shown[tally.state] = !shown[tally.state]),
)}
							</li>
						{/if}
					{/each}
					{#if staleCount > 0}
						<li class="inline-flex">
							{@render toggle(
"Stale threads",
"stale",
"text-thread-stale",
staleCount,
showStale,
() => (showStale = !showStale),
)}
						</li>
					{/if}
				</ul>
				<span class="flex-1"></span>
				<ButtonGroup>
					{#each VIEW_IDS as id (id)}
						<Button
							joined
							size="xs"
							aria-pressed={activeView === id}
							onclick={() => pick(id)}
						>
							{VIEWS[id].label}
							<span class="font-mono"
								>{threads.filter((t) => VIEWS[id].states.includes(t.state)).length}</span
							>
						</Button>
					{/each}
				</ButtonGroup>
			{/if}
		</div>
	</header>

	<div
		class="flex min-h-0 flex-1 flex-col overflow-auto bg-surface pb-6 text-callout leading-normal text-text"
	>
		{#if threads.length === 0}
			<p class="m-0 px-4 py-6 text-text-muted">No comments in this review.</p>
		{:else if hiddenCount === threads.length}
			<p class="m-0 px-4 py-6 text-text-muted">
				No threads here.
				<LinkButton tone="accent" onclick={() => pick("all")}
					>Show all</LinkButton
				>
			</p>
		{/if}
		{#each review.sections.filter((sec) => sec.groups.some((g) => visible(g).length > 0)) as section (section.branch)}
			<section
				class="proto-branch"
				aria-label="Branch {section.branch}"
				style:--lane={laneColor(section.lane)}
			>
				<header
					class="proto-branch-head flex h-bar items-center gap-2 bg-surface-raised pr-4 pl-3"
				>
					<Chip variant="label" tone="lane">{section.branch}</Chip>
					{#if section.checkedOut}
						<span class="proto-meta">checked out</span>
					{/if}
					<span class="flex-1"></span>
					<span class="proto-meta"
						>{plural(
section.groups.reduce((n, g) => n + visible(g).length, 0),
							"thread",
						)}</span
					>
				</header>
				<ul class="m-0 list-none p-0">
					{#each section.groups.filter((g) => visible(g).length > 0) as group (group.key)}
						<li class="proto-group">
							<div class="proto-group-head h-bar bg-surface">
								<FoldBar
									noun={group.target.kind === "commit" ? "commit" : "uncommitted changes"}
									inset="group"
									collapsed={!!folded[group.key]}
									ontoggle={() => toggleFold(group.key)}
								>
									{#snippet lead()}
										<span
											class="proto-node"
											data-kind={group.target.kind}
										></span>
									{/snippet}
									{#if group.target.kind === "commit"}
										<Chip variant="label" tone="neutral"
											>{group.target.sha}</Chip
										>
										<span class="min-w-0 truncate text-text-strong"
											>{group.target.summary}</span
										>
									{:else}
										<span class="font-medium text-text-strong"
											>Uncommitted changes</span
										>
									{/if}
									<span
										class="inline-flex h-control-xs shrink-0 items-center rounded bg-surface-chip px-1 font-mono text-caption text-text-muted"
										>{visible(group).length}</span
									>
								</FoldBar>
							</div>
							{#if !folded[group.key]}
								<div class="proto-group-list flex flex-col gap-3">
									{#each byFile(group) as file (file.path)}
										<div class="flex flex-col gap-2">
											{#if file.path !== null}
												{@const key = fileKey(group, file.path)}
												<div class="font-mono text-small text-text-strong">
													<FoldBar
														noun="file"
														inset="file"
														collapsed={!!folded[key]}
														ontoggle={() => toggleFold(key)}
													>
														<File size={12} aria-hidden="true" />
														<span class="min-w-0 truncate">{file.path}</span>
														<span class="flex-1"></span>
														<span class="proto-meta"
															>{plural(file.threads.length, "thread")}</span
														>
													</FoldBar>
												</div>
											{/if}
											{#if file.path === null || !folded[fileKey(group, file.path)]}
												{#each file.threads as thread (thread.id)}
													{@const at = group.threads.indexOf(thread)}
													<ProtoThread
														bind:thread={group.threads[at]}
														ondelete={() => removeThread(group, thread)}
													/>
												{/each}
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
		{#if hiddenCount > 0 && hiddenCount < threads.length}
			<p class="m-0 px-4 pt-3 text-small text-text-muted">
				{plural(hiddenCount, "thread")}
				hidden.
				<LinkButton tone="accent" onclick={() => pick("all")}
					>Show all</LinkButton
				>
			</p>
		{/if}
	</div>

	<p
		class="proto-keys m-0 flex h-bar shrink-0 items-center gap-1 overflow-hidden px-4 whitespace-nowrap text-small text-text-subtle"
		role="note"
		aria-label="Keyboard shortcuts"
	>
		{#each KEYS as [keys, meaning] (meaning)}
			{#each keys as key (key)}
				<Keycap>{key}</Keycap>
			{/each}
			<span class="mr-2">{meaning}</span>
		{/each}
	</p>
</section>

<style>
.proto-branch + .proto-branch {
	margin-top: var(--space-3);
}
.proto-branch-head {
	position: sticky;
	top: 0;
	z-index: 4;
	border-top: 1px solid var(--color-border);
	box-shadow: var(--shadow-hairline);
}
.proto-meta {
	font-family: var(--font-mono);
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	white-space: nowrap;
}
.proto-group {
	position: relative;
}
.proto-group::before {
	content: "";
	position: absolute;
	left: calc(var(--space-4) + var(--u));
	top: calc(var(--bar-h) / 2);
	bottom: 0;
	width: calc(var(--u) / 2);
	background: color-mix(in oklch, var(--lane) 55%, transparent);
}
.proto-group:last-child::before {
	bottom: var(--space-3);
}
.proto-group-head {
	position: sticky;
	top: var(--bar-h);
	z-index: 3;
	box-shadow: var(--shadow-hairline);
}
.proto-group + .proto-group .proto-group-head {
	border-top: 1px solid var(--color-border);
}
.proto-node {
	position: relative;
	z-index: 1;
	flex-shrink: 0;
	width: calc(5 * var(--u) / 2);
	height: calc(5 * var(--u) / 2);
	border-radius: 50%;
	background: var(--lane);
}
.proto-node[data-kind="uncommitted"] {
	background: var(--color-surface);
	border: 1px dashed var(--lane);
}
.proto-group-list {
	padding: var(--space-2) var(--space-4) var(--space-3)
		calc(var(--space-4) + var(--space-5));
}
.proto-keys {
	border-top: 1px solid var(--color-border);
}
</style>
