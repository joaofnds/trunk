<script lang="ts">
// The review panel: the shown review's name and actions over a tally of its
// threads, then its threads by branch, by commit and by file, and the keys
// that move between them at the foot.

import Archive from "@lucide/svelte/icons/archive";
import Copy from "@lucide/svelte/icons/copy";
import File from "@lucide/svelte/icons/file";
import type { Attachment } from "svelte/attachments";
import StateGlyph from "../../components/review/StateGlyph.svelte";
import StatePill from "../../components/review/StatePill.svelte";
import { laneColor } from "../../lib/lanes.js";
import { tooltip } from "../../lib/tooltip.js";
import type { ThreadState } from "../../lib/types.js";
import Badge from "../../lib/ui/Badge.svelte";
import Button from "../../lib/ui/Button.svelte";
import ButtonGroup from "../../lib/ui/ButtonGroup.svelte";
import Chip from "../../lib/ui/Chip.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";
import LinkButton from "../../lib/ui/LinkButton.svelte";
import Radio from "../../lib/ui/Radio.svelte";
import FoldBar from "./FoldBar.svelte";
import type { FileVariant } from "./file-variants.js";
import type { Group, Review, Thread } from "./mock.js";
import ProtoThread from "./ProtoThread.svelte";

interface Props {
	review: Review;
	active: boolean;
	/** How a whole-file thread and a long excerpt are drawn. */
	fileVariant: FileVariant;
}

let { review = $bindable(), active, fileVariant }: Props = $props();

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
	// A thread on the whole file leads its file's threads, as the file's header
	// leads its lines, except today, when it is a range starting at line 1.
	const lead = (thread: Thread) =>
		fileVariant !== "today" && thread.scope.kind === "file" ? 0 : 1;
	return [...files].map(([path, threads]) => ({
		path,
		threads: threads.toSorted((a, b) => lead(a) - lead(b)),
	}));
}

function isNote(thread: Thread): boolean {
	return fileVariant === "note" && thread.scope.kind === "file";
}

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf("/");
	return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function hint(text: string): Attachment<HTMLElement> {
	return (node) => {
		const handle = tooltip(node, text);
		return () => handle.destroy();
	};
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
name: string,
glyph: ThreadState | "stale",
tone: string,
count: number,
on: boolean,
ontoggle: () => void,
)}
	<LinkButton
		tone="muted"
		aria-pressed={on}
		aria-label="{name} threads"
		onclick={ontoggle}
		{@attach hint(
			`${name}: ${plural(count, "thread")}. Click to ${on ? "hide" : "show"}.`,
		)}
	>
		<span
			class="inline-flex items-center gap-1 font-mono"
			class:line-through={!on}
			class:text-text-disabled={!on}
		>
			<span class="inline-flex {tone}" aria-hidden="true">
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
			<Badge variant="label">{review.id}</Badge>
			<StatePill review={review.state} />
			<span class="flex-1"></span>
			<Button size="xs"><File size={12} />Comment on a file…</Button>
			<Button size="xs"><Copy size={12} />Copy</Button>
			<Button size="xs"><Archive size={12} />Archive</Button>
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
tally.label,
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
"Stale",
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
				<ButtonGroup size="xs">
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
		class="flex min-h-0 flex-1 flex-col overflow-auto bg-bg pb-6 text-callout leading-normal text-text"
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
				aria-label="Branch {section.branch}"
				style:--lane={laneColor(section.lane)}
			>
				<header
					class="proto-branch-head flex h-bar items-center gap-2 bg-surface-raised px-4"
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
						<li>
							<div class="proto-group-head h-bar bg-surface">
								<FoldBar
									noun={group.target.kind === "commit" ? "commit" : "uncommitted changes"}
									inset="group"
									collapsed={!!folded[group.key]}
									ontoggle={() => toggleFold(group.key)}
								>
									{#snippet lead()}
										<span
											class="inline-flex w-control-xs shrink-0 justify-center"
										>
											<span
												class="proto-node"
												data-kind={group.target.kind}
											></span>
										</span>
									{/snippet}
									{#if group.target.kind === "commit"}
										<Badge variant="label">{group.target.sha}</Badge>
										<span
											class="min-w-0 truncate text-body font-medium text-text-strong"
											>{group.target.summary}</span
										>
									{:else}
										<span class="text-body font-medium text-text-strong"
											>Uncommitted changes</span
										>
									{/if}
									<span class="flex-1"></span>
									<span class="proto-meta"
										>{plural(visible(group).length, "thread")}</span
									>
								</FoldBar>
							</div>
							{#if !folded[group.key]}
								<div class="proto-group-list flex flex-col gap-2">
									{#each byFile(group) as file (file.path)}
										<div class="flex flex-col gap-2">
											{#if file.path !== null}
												{@const key = fileKey(group, file.path)}
												{@const parts = splitPath(file.path)}
												<div
													class="h-bar font-mono text-small text-text-subtle"
												>
													<FoldBar
														noun="file"
														inset="file"
														collapsed={!!folded[key]}
														ontoggle={() => toggleFold(key)}
													>
														<File size={12} aria-hidden="true" />
														<span class="flex min-w-0">
															<span class="min-w-0 truncate">{parts.dir}</span>
															<span
																class="shrink-0 font-medium text-text-strong"
																>{parts.name}</span
															>
														</span>
														<span class="flex-1"></span>
														{#if file.threads.some(isNote)}
															<span class="proto-meta"
																>{plural(file.threads.filter(isNote).length, "file note")}
																·</span
															>
														{/if}
														<span class="proto-meta"
															>{plural(
file.threads.filter((t) => !isNote(t)).length,
																"thread",
															)}</span
														>
													</FoldBar>
												</div>
											{/if}
											{#if file.path === null || !folded[fileKey(group, file.path)]}
												{#each file.threads as thread (thread.id)}
													{@const at = group.threads.indexOf(thread)}
													<ProtoThread
														bind:thread={group.threads[at]}
														variant={isNote(thread) ? "note" : "panel"}
														{fileVariant}
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
.proto-branch-head {
	position: sticky;
	top: 0;
	z-index: 4;
	box-shadow: var(--shadow-hairline);
}
.proto-meta {
	font-family: var(--font-mono);
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	white-space: nowrap;
}
.proto-group-head {
	position: sticky;
	top: var(--bar-h);
	z-index: 3;
	box-shadow: var(--shadow-hairline);
}
.proto-node {
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
	padding: 0 var(--space-4) var(--space-4)
		calc(var(--space-4) + var(--control-xs-h) + var(--space-2));
	box-shadow: var(--shadow-hairline);
}
.proto-keys {
	border-top: 1px solid var(--color-border);
}
</style>
