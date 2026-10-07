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
import Button from "../../lib/ui/Button.svelte";
import Chip from "../../lib/ui/Chip.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";
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
	{ state: "open", tone: "text-thread-open" },
	{ state: "addressed", tone: "text-thread-addressed" },
	{ state: "done", tone: "text-thread-done" },
	{ state: "dismissed", tone: "text-thread-dismissed" },
] as const;

const KEYS: [string[], string][] = [
	[["J", "K"], "move"],
	[["↵"], "open code"],
	[["R"], "reply"],
	[["D"], "done"],
	[["X"], "dismiss"],
	[["O"], "reopen"],
];

const threads = $derived(
	review.sections.flatMap((s) => s.groups.flatMap((g) => g.threads)),
);
const staleCount = $derived(threads.filter((t) => t.stale).length);

function byFile(group: Group): { path: string | null; threads: Thread[] }[] {
	const files = new Map<string | null, Thread[]>();
	for (const thread of group.threads) {
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
				<ul class="m-0 flex list-none gap-3 p-0" aria-label="Threads by state">
					{#each TALLY as tally (tally.state)}
						{@const count = threads.filter((t) => t.state === tally.state).length}
						{#if count > 0}
							<li
								class="inline-flex items-center gap-1 font-mono text-text-muted"
							>
								<span class="inline-flex {tally.tone}" aria-hidden="true">
									<StateGlyph state={tally.state} size={11} />
								</span>
								{count}
							</li>
						{/if}
					{/each}
					{#if staleCount > 0}
						<li
							class="inline-flex items-center gap-1 font-mono text-text-muted"
						>
							<span class="inline-flex text-thread-stale" aria-hidden="true">
								<StateGlyph state="stale" size={11} />
							</span>
							{staleCount}
						</li>
					{/if}
				</ul>
			{/if}
		</div>
	</header>

	<div
		class="flex min-h-0 flex-1 flex-col overflow-auto bg-surface pb-6 text-callout leading-normal text-text"
	>
		{#if threads.length === 0}
			<p class="m-0 px-4 py-6 text-text-muted">No comments in this review.</p>
		{/if}
		{#each review.sections as section (section.branch)}
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
							section.groups.reduce((n, g) => n + g.threads.length, 0),
							"thread",
						)}</span
					>
				</header>
				<ul class="m-0 list-none p-0">
					{#each section.groups as group (group.key)}
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
										>{group.threads.length}</span
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
