<script lang="ts">
import Plus from "@lucide/svelte/icons/plus";
import X from "@lucide/svelte/icons/x";
import type Sortable from "sortablejs";
import { keyChord } from "../lib/keyboard.js";
import {
	displayPath,
	repositoryParts,
	repositorySeparator,
} from "../lib/path.js";
import {
	canMoveTab,
	moveTab,
	moveTabTo,
	type TabStep,
} from "../lib/tab-order.js";
import type { TabInfo } from "../lib/tab-types.js";
import { showToast } from "../lib/toast.svelte.js";
import Button from "../lib/ui/Button.svelte";
import Tab from "../lib/ui/Tab.svelte";
import { isSideways } from "../lib/wheel.js";

interface Props {
	tabs: TabInfo[];
	activeTabId: string;
	onactivate: (tabId: string) => void;
	onclose: (tabId: string, force: boolean) => void;
	onnew: () => void;
	oncontextmenu: (tabId: string, event: MouseEvent) => void;
	onauxclose: (tabId: string) => void;
	onreorder: (newTabs: TabInfo[]) => void;
}

let {
	tabs,
	activeTabId,
	onactivate,
	onclose,
	onnew,
	oncontextmenu,
	onauxclose,
	onreorder,
}: Props = $props();

let tabBarEl: HTMLDivElement;
let resolvedPaths: Record<string, string> = $state({});

$effect(() => {
	for (const tab of tabs) {
		const path = tab.repoPath;
		if (path && !(path in resolvedPaths)) {
			displayPath(path).then((p) => {
				resolvedPaths[path] = p;
			});
		}
	}
});

// Prefer a complete trailing word when long checkout directories differ there.
// With no distinct word, show the part where similar directory names diverge.
function compactAncestor(name: string, peers: string[]): string {
	if (name.length <= 18) return name;
	for (const separator of name.matchAll(/[-_. ]+/g)) {
		const tail = name.slice(separator.index + separator[0].length);
		if (
			tail &&
			tail.length <= 18 &&
			!peers.some((peer) => peer.endsWith(tail))
		) {
			return `…${tail}`;
		}
	}
	let shared = 0;
	for (const peer of peers) {
		let i = 0;
		while (i < name.length && name[i] === peer?.[i]) i++;
		shared = Math.max(shared, i);
	}
	const start = Math.min(Math.max(0, shared - 5), name.length - 16);
	const end = start + 16;
	const excerpt = name.slice(start, end);
	if (!peers.some((peer) => peer?.includes(excerpt))) {
		return (start ? "…" : "") + excerpt + (end < name.length ? "…" : "");
	}
	const ends = (value: string) => `${value.slice(0, 7)}…${value.slice(-8)}`;
	const label = ends(name);
	const similar = peers.filter((peer) => peer && ends(peer) === label);
	if (!similar.length) return label;
	const position = [...new Set([...similar, name])].sort().indexOf(name) + 1;
	return `${label}·${position}`;
}

// The first different ancestor identifies the checkout. A leading slash
// distinguishes /services/api from /work/services/api at the root.
const parentLabels = $derived.by(() => {
	const groups = new Map<string, Map<string, string[]>>();
	for (const { repoName, repoPath } of tabs) {
		if (!repoPath) continue;
		let paths = groups.get(repoName);
		if (!paths) {
			paths = new Map();
			groups.set(repoName, paths);
		}
		paths.set(repoPath, repositoryParts(repoPath).slice(0, -1));
	}
	const labels = new Map<string, { ancestor: string; tail: string }>();
	for (const paths of groups.values()) {
		if (paths.size < 2) continue;
		for (const [path, parents] of paths) {
			const separator = repositorySeparator(path);
			const others = [...paths].filter(([other]) => other !== path);
			let depth = 1;
			let suffix = parents.slice(-depth).join("/");
			while (
				depth < parents.length &&
				others.some(([, parts]) => parts.slice(-depth).join("/") === suffix)
			) {
				depth++;
				suffix = parents.slice(-depth).join("/");
			}
			const [name, ...tail] = parents.slice(-depth);
			const peers = others.map(([, parts]) => parts.slice(-depth)[0]);
			labels.set(path, {
				ancestor: compactAncestor(name || separator, peers),
				tail: tail.length ? (name ? separator : "") + tail.join(separator) : "",
			});
		}
	}
	return labels;
});

function reveal(item: Element) {
	item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// The strip narrows with the window and when a repository's toolbar appears
// beside it, and the active tab widens when a repository opens in it: either
// can push the active tab out of view without a change of tab.
function itemFor(tabId: string): Element | null {
	return tabBarEl.querySelector(`[data-tab-id="${tabId}"]`);
}

$effect(() => {
	const active = itemFor(activeTabId);
	if (!active) return;

	reveal(active);

	const observer = new ResizeObserver(() => reveal(active));
	observer.observe(tabBarEl);
	observer.observe(active);

	return () => observer.disconnect();
});

/** How much of a tab the strip shows: all of it, part of it, or none. */
type Shown = "whole" | "cut" | "out";

let shown: Record<string, Shown> = $state.raw({});

function shownBy(entry: IntersectionObserverEntry): Shown {
	if (!entry.isIntersecting) return "out";

	return entry.intersectionRatio < 1 ? "cut" : "whole";
}

$effect(() => {
	const ids = new Map<Element, string>();
	const seen: Record<string, Shown> = {};
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const id = ids.get(entry.target);
				if (id) seen[id] = shownBy(entry);
			}
			shown = { ...seen };
		},
		// The margin keeps a tab whose edge rounds past the strip's by a
		// fraction of a pixel whole.
		{ root: tabBarEl, rootMargin: "0px 1px", threshold: [0, 1] },
	);
	for (const tab of tabs) {
		const item = tabBarEl.querySelector(`[data-tab-id="${tab.id}"]`);
		if (!item) continue;

		ids.set(item, tab.id);
		observer.observe(item);
	}

	return () => observer.disconnect();
});

function isWhole(tab: TabInfo | undefined): boolean {
	return tab === undefined || (shown[tab.id] ?? "whole") === "whole";
}

const fades = $derived({
	start: !isWhole(tabs[0]),
	end: !isWhole(tabs.at(-1)),
});

function scrollSideways(e: WheelEvent) {
	if (isSideways(e)) return;

	tabBarEl.scrollLeft += e.deltaY;
}

// Reordering takes a tab item out of the page and puts it back, and the page
// drops the focus of anything inside an item it takes out.
let focusedInStrip: HTMLElement | null = null;

$effect.pre(() => {
	void tabs;
	const focused = document.activeElement;
	focusedInStrip =
		focused instanceof HTMLElement && tabBarEl?.contains(focused)
			? focused
			: null;
});

// A tab the keys move can pass the edge of a strip that overflows.
let movedByKey: string | null = null;

$effect(() => {
	void tabs;
	if (focusedInStrip?.isConnected && document.activeElement === document.body)
		focusedInStrip.focus({ preventScroll: true });

	const moved = movedByKey && itemFor(movedByKey);
	movedByKey = null;
	if (moved) reveal(moved);
});

const canReorder = $derived(tabs.length > 1);

$effect(() => {
	if (!tabBarEl || !canReorder) return;

	let disposed = false;
	let sortable: Sortable | undefined;

	void import("sortablejs")
		.then(({ default: SortableJS }) => {
			if (disposed) return;

			sortable = SortableJS.create(tabBarEl, {
				animation: 150,
				direction: "horizontal",
				forceFallback: true,
				ghostClass: "tab-ghost",
				chosenClass: "tab-chosen",
				dragClass: "tab-drag",
				draggable: ".tab-item",
				scroll: true,
				scrollSensitivity: 50,
				onEnd: (e) => {
					if (
						e.oldIndex == null ||
						e.newIndex == null ||
						e.oldIndex === e.newIndex
					)
						return;

					onreorder(moveTabTo(tabs, e.oldIndex, e.newIndex));
				},
			});
		})
		.catch((error) => {
			if (disposed) return;

			console.error("Could not enable tab reordering", error);
			showToast("Could not enable tab reordering", "error");
		});

	return () => {
		disposed = true;
		sortable?.destroy();
	};
});

const MOVE_CHORDS = new Map<string, TabStep>([
	["Meta+Shift+ArrowLeft", -1],
	["Meta+Shift+ArrowRight", 1],
	["Ctrl+Shift+ArrowLeft", -1],
	["Ctrl+Shift+ArrowRight", 1],
]);

function activateOrMoveOnKey(e: KeyboardEvent, tabId: string) {
	if (e.key === "Enter" || e.key === " ") {
		onactivate(tabId);
		return;
	}

	const step = MOVE_CHORDS.get(keyChord(e));
	if (step === undefined) return;

	e.preventDefault();
	if (!canMoveTab(tabs, tabId, step)) return;

	movedByKey = tabId;
	onreorder(moveTab(tabs, tabId, step));
}

function activateOnPrimary(e: MouseEvent, tabId: string) {
	if (e.button === 0) onactivate(tabId);
}

function pressClose(
	e: MouseEvent & { currentTarget: HTMLButtonElement },
	tabId: string,
) {
	e.preventDefault();
	e.currentTarget
		.closest(".tab-item")
		?.querySelector<HTMLElement>('[role="tab"]')
		?.focus({ preventScroll: true, focusVisible: false });

	activateOnPrimary(e, tabId);
}

function openMenu(e: MouseEvent, tabId: string) {
	e.preventDefault();
	oncontextmenu(tabId, e);
}

function closeOnMiddle(e: MouseEvent, tabId: string) {
	if (e.button !== 1) return;

	e.preventDefault();
	onauxclose(tabId);
}
</script>

<!--
	Each tab item is the element SortableJS drags, and holds the tab's button
	with the close over its trailing edge as a sibling. An event on the close
	never reaches the tab, so the close is handed what a press, a right click
	and a middle click anywhere on the item do, the focus a press gives the
	tab included. Nothing inside an item may turn pointer events back on:
	SortableJS switches them off on the copy it drags, and a descendant that
	opts back in is found under the pointer as a drop target.
-->
<div class="flex h-full min-w-0 items-center">
	<div
		class="tab-bar"
		class:fades-start={fades.start}
		class:fades-end={fades.end}
		role="tablist"
		aria-label="Repository tabs"
		data-scroll-thumb="none"
		bind:this={tabBarEl}
		onwheel={scrollSideways}
	>
		{#each tabs as tab (tab.id)}
			{@const parent = tab.repoPath && parentLabels.get(tab.repoPath)}
			{@const title = tab.repoPath
				? (resolvedPaths[tab.repoPath] ?? tab.repoPath)
				: tab.repoName || "New Tab"}
			<div
				class="tab-item"
				class:qualified={!!parent}
				class:active={tab.id === activeTabId}
				role="presentation"
				data-tab-id={tab.id}
				{title}
			>
				<Tab
					variant="framed"
					aria-label={parent ? `${tab.repoName}, ${tab.repoPath}` : undefined}
					selected={tab.id === activeTabId}
					{title}
					onmousedown={(e) => activateOnPrimary(e, tab.id)}
					onkeydown={(e) => activateOrMoveOnKey(e, tab.id)}
					oncontextmenu={(e) => openMenu(e, tab.id)}
					onauxclick={(e) => closeOnMiddle(e, tab.id)}
				>
					<span class="tab-label flex-1 min-w-0 flex items-baseline gap-1">
						<span class="tab-text cut">{tab.repoName || "New Tab"}</span>
						{#if parent}
							<span
								class="tab-parent inline-flex text-small font-regular text-text-muted"
							>
								<span class="tab-text">{parent.ancestor}</span
								><span class="tab-text cut">{parent.tail}</span>
							</span>
						{/if}
					</span>
					{#snippet trailing()}
						<span class="tab-slot">
							{#if tab.dirty}
								<span class="dirty-dot"></span>
							{/if}
							{#if shown[tab.id] !== "cut"}
								<span class="tab-close inline-flex">
									<Button
										icon
										size="xs"
										variant="ghost"
										aria-label="Close tab"
										onmousedown={(e) => pressClose(e, tab.id)}
										oncontextmenu={(e) => openMenu(e, tab.id)}
										onauxclick={(e) => closeOnMiddle(e, tab.id)}
										onclick={(e) => {
											e.stopPropagation();
											onclose(tab.id, e.shiftKey);
										}}
									>
										<X size={12} />
									</Button>
								</span>
							{/if}
						</span>
					{/snippet}
				</Tab>
			</div>
		{/each}
	</div>
	<span
		class="mx-1 inline-flex shrink-0 rounded outline-1 outline-dashed -outline-offset-1 outline-border"
	>
		<Button icon variant="ghost" aria-label="New tab" onclick={onnew}>
			<Plus size={14} />
		</Button>
	</span>
</div>

<style>
.tab-bar {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	height: 100%;
	padding: 0 var(--space-1);
	overflow-x: auto;
	overflow-y: hidden;
	scrollbar-width: none;
	/* Narrower than the fade, it leaves a revealed tab under the fade. */
	scroll-padding-inline: var(--space-6);
}

.tab-bar.fades-start {
	mask-image: linear-gradient(to right, transparent, black var(--space-6));
}

.tab-bar.fades-end {
	mask-image: linear-gradient(to left, transparent, black var(--space-6));
}

.tab-bar.fades-start.fades-end {
	mask-image: linear-gradient(
		to right,
		transparent,
		black var(--space-6),
		black calc(100% - var(--space-6)),
		transparent
	);
}

/* Each tab is as wide as its label. When the strip runs out of room the widest
   tabs narrow first, so a short name stays whole while a long one is cut. The
   floor sits just under a three-letter name's natural width, so it pads only a
   name of one or two letters, and still keeps a letter clear of the close. */
.tab-item {
	display: grid;
	flex: 1 1 0;
	min-width: calc(12 * var(--u));
	max-width: max-content;
	height: var(--control-h);
	border-radius: var(--radius);
	font-size: var(--text-callout);
	font-weight: var(--weight-regular);
	color: var(--color-text-muted);
	grid-template-columns: minmax(0, auto);
	white-space: nowrap;
	background: none;
}

.tab-label {
	max-width: calc(50 * var(--u));
}

/* Centres the lowercase body of the text, not its line box, on the dot and the
   close, which otherwise sit a pixel above it. */
.tab-text {
	text-box: trim-both ex alphabetic;
}

/* Clipped across only: a box clipped in both directions would cut off the
   ascenders the trim leaves outside it. */
.tab-text.cut {
	min-width: 0;
	overflow-x: clip;
	overflow-y: visible;
	text-overflow: ellipsis;
}

.tab-item.qualified {
	flex: none;
}

.tab-item.qualified .tab-label {
	max-width: none;
}

.tab-item.qualified .tab-label > :first-child {
	max-width: 16ch;
}

.tab-parent > :last-child {
	max-width: 12ch;
}

.tab-item:hover {
	color: var(--color-text);
	background: color-mix(in oklch, var(--color-hover) 35%, transparent);
}

.tab-item.active {
	color: var(--color-text-strong);
	font-weight: var(--weight-medium);
	background: var(--color-surface-chip);
	box-shadow:
		inset 0 0 0 1px var(--color-border-strong),
		0 1px 3px var(--color-backdrop);
}

.dirty-dot {
	width: calc(3 * var(--u) / 2);
	height: calc(3 * var(--u) / 2);
	border-radius: 50%;
	background: var(--color-accent);
}

/* A dirty tab shows its dot where the close sits, and the close takes that
   place under the pointer or the keyboard's focus. */
.tab-slot {
	display: grid;
	place-items: center;
	width: var(--control-xs-h);
	height: var(--control-xs-h);
}

.tab-slot > * {
	grid-area: 1 / 1;
}

/* Opacity, not visibility, hides a resting close, so a screen reader still finds
   it and the keyboard still reaches it in either direction. The focus test is
   global because the focusable buttons belong to the primitives, which this
   component's scoped class never reaches. */
.tab-close {
	opacity: 0;
}

.tab-item:is(.active, :hover, :has(:global(:focus-visible))) .tab-close {
	opacity: 1;
}

.tab-item:is(:hover, :has(:global(:focus-visible))) .dirty-dot {
	visibility: hidden;
}

.tab-item.active:not(:hover, :has(:global(:focus-visible)))
	.dirty-dot
	~ .tab-close {
	opacity: 0;
}

:global(.tab-ghost) {
	opacity: 0.4;
}

.tab-item:global(.tab-chosen),
.tab-item:global(.tab-chosen):hover {
	background: var(--color-selected-row);
}

:global(.tab-drag) {
	opacity: 0;
}
</style>
