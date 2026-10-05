<script lang="ts">
import Plus from "@lucide/svelte/icons/plus";
import X from "@lucide/svelte/icons/x";
import Sortable from "sortablejs";
import { displayPath } from "../lib/path.js";
import type { TabInfo } from "../lib/tab-types.js";
import Button from "../lib/ui/Button.svelte";
import Tab from "../lib/ui/Tab.svelte";

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

$effect(() => {
	const activeButton = tabBarEl?.querySelector(
		`[data-tab-id="${activeTabId}"]`,
	);
	activeButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
});

$effect(() => {
	if (!tabBarEl) return;
	const sortable = Sortable.create(tabBarEl, {
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
			if (e.oldIndex == null || e.newIndex == null || e.oldIndex === e.newIndex)
				return;
			const updated = [...tabs];
			const [moved] = updated.splice(e.oldIndex, 1);
			updated.splice(e.newIndex, 0, moved);
			onreorder(updated);
		},
	});
	return () => sortable.destroy();
});

const CLOSE =
	"col-start-2 row-start-1 flex items-center px-2 pointer-events-none *:pointer-events-auto";

function press(e: MouseEvent, tabId: string) {
	if (e.button === 0) onactivate(tabId);
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
	Each chip stays the element SortableJS drags, and holds the tab's button
	with the close over its trailing edge as a sibling. An event on the close
	never reaches the tab, so the close is handed what a press, a right click
	and a middle click anywhere on the chip do.
-->
<div
	class="tab-bar"
	role="tablist"
	aria-label="Repository tabs"
	bind:this={tabBarEl}
>
	{#each tabs as tab (tab.id)}
		<div
			class="tab-item"
			class:active={tab.id === activeTabId}
			role="presentation"
			data-tab-id={tab.id}
			title={tab.repoPath ? (resolvedPaths[tab.repoPath] ?? tab.repoPath) : tab.repoName || 'New Tab'}
		>
			<Tab
				variant="chip"
				selected={tab.id === activeTabId}
				tabindex={0}
				onmousedown={(e) => press(e, tab.id)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onactivate(tab.id); }}
				oncontextmenu={(e) => openMenu(e, tab.id)}
				onauxclick={(e) => closeOnMiddle(e, tab.id)}
			>
				{#if tab.dirty}
					<span class="dirty-dot"></span>
				{/if}
				<span class="truncate tab-label flex-1"
					>{tab.repoName || 'New Tab'}</span
				>
			</Tab>
			<div class={CLOSE}>
				<Button
					icon
					size="xs"
					variant="ghost"
					aria-label="Close tab"
					onmousedown={(e: MouseEvent) => press(e, tab.id)}
					oncontextmenu={(e: MouseEvent) => openMenu(e, tab.id)}
					onauxclick={(e: MouseEvent) => closeOnMiddle(e, tab.id)}
					onclick={(e: MouseEvent) => { e.stopPropagation(); onclose(tab.id, e.shiftKey); }}
				>
					<X size={12} />
				</Button>
			</div>
		</div>
	{/each}
	<span
		class="ml-1 inline-flex shrink-0 rounded outline-1 outline-dashed -outline-offset-1 outline-border"
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
}

.tab-item {
	display: grid;
	grid-template-columns: auto auto;
	height: var(--control-h);
	border-radius: var(--radius);
	font-size: var(--text-callout);
	font-weight: var(--weight-medium);
	color: var(--color-text-muted);
	white-space: nowrap;
	flex-shrink: 0;
	background: none;
	/* Paint, not length: the active state's outline must not take a pixel out
       of a chip already declaring its height. */
	box-shadow: inset 0 0 0 1px transparent;
}

.tab-item:hover {
	color: var(--color-text);
	background: var(--color-hover);
}

.tab-item.active {
	color: var(--color-text-strong);
	background: var(--color-surface-raised);
	box-shadow: inset 0 0 0 1px var(--color-border);
}

.tab-item.active:hover {
	background: var(--color-surface-raised);
}

.dirty-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-accent);
	flex-shrink: 0;
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
.tab-label {
	max-width: calc(50 * var(--u));
}
</style>
