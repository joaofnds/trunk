<script lang="ts">
import { Plus, X } from "@lucide/svelte";
import Sortable from "sortablejs";
import { displayPath } from "../lib/path.js";
import type { TabInfo } from "../lib/tab-types.js";

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
		filter: ".new-tab-btn",
		preventOnFilter: false,
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
</script>

<div class="tab-bar" bind:this={tabBarEl}>
  {#each tabs as tab (tab.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tab-item"
      class:active={tab.id === activeTabId}
      data-tab-id={tab.id}
      title={tab.repoPath ? (resolvedPaths[tab.repoPath] ?? tab.repoPath) : tab.repoName || 'New Tab'}
      onmousedown={(e: MouseEvent) => { if (e.button === 0) onactivate(tab.id); }}
      onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onactivate(tab.id); }}
      oncontextmenu={(e: MouseEvent) => { e.preventDefault(); oncontextmenu(tab.id, e); }}
      onauxclick={(e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); onauxclose(tab.id); } }}
      role="tab"
      tabindex="0"
      aria-selected={tab.id === activeTabId}
    >
      {#if tab.dirty}<span class="dirty-dot"></span>{/if}
      <span class="truncate" style="max-width: 200px; flex: 1;">{tab.repoName || 'New Tab'}</span>
      <button
        class="close-btn"
        onclick={(e: MouseEvent) => { e.stopPropagation(); onclose(tab.id, e.shiftKey); }}
        aria-label="Close tab"
      >
        <X size={12} />
      </button>
    </div>
  {/each}
  <button class="new-tab-btn" onclick={onnew} aria-label="New tab">
    <Plus size={14} />
  </button>
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
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2) 0 var(--space-3);
    height: var(--control-h);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-2);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    background: none;
    /* Paint, not length: the active state's outline must not take a pixel out
       of a chip already declaring its height. */
    box-shadow: inset 0 0 0 1px transparent;
  }

  .tab-item:hover {
    color: var(--fg-1);
    background: var(--bg-hover);
  }

  .tab-item.active {
    color: var(--fg-0);
    background: var(--bg-2);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .tab-item.active:hover {
    background: var(--bg-2);
  }

  .dirty-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: var(--radius);
    border: none;
    background: none;
    color: var(--fg-2);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: background-color 0.15s, color 0.15s;
  }

  .close-btn:hover {
    background: var(--bg-3);
    color: var(--fg-1);
  }

  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--control-h);
    height: var(--control-h);
    border-radius: var(--radius);
    /* Dashed, because this is an add affordance rather than a real tab, and
       a box-shadow cannot render a dash pattern. An outline is paint like an
       inset shadow — it sits outside the box and costs the declared size
       nothing, which is why the border this replaced had to go. */
    outline: 1px dashed var(--line);
    outline-offset: -1px;
    background: none;
    color: var(--fg-2);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    margin-left: var(--space-1);
    transition: background-color 0.15s, color 0.15s;
  }

  .new-tab-btn:hover {
    background: var(--bg-hover);
    color: var(--fg-1);
  }

  :global(.tab-ghost) {
    opacity: 0.4;
  }

  :global(.tab-chosen) {
    background: var(--bg-selected) !important;
  }

  :global(.tab-drag) {
    opacity: 0;
  }
</style>
