<script lang="ts">
import { ChevronDown, ChevronUp, X } from "@lucide/svelte";
import { slide } from "svelte/transition";

interface Props {
	query: string;
	currentIndex: number;
	totalMatches: number;
	onquerychange: (query: string) => void;
	onnext: () => void;
	onprev: () => void;
	onclose: () => void;
}

let {
	query,
	currentIndex,
	totalMatches,
	onquerychange,
	onnext,
	onprev,
	onclose,
}: Props = $props();

let inputValue = $state("");

// Sync local input state with the query prop
$effect(() => {
	inputValue = query;
});

function handleInput() {
	onquerychange(inputValue);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		onclose();
	} else if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		onprev();
	} else if (e.key === "Enter") {
		e.preventDefault();
		onnext();
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}
</script>

<div
  class="search-bar"
  transition:slide={{ duration: 150, axis: 'y' }}
  style="
    position: absolute;
    top: 0;
    right: 8px;
    z-index: 10;
    width: 300px;
    height: var(--control-lg-h);
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    display: flex;
    align-items: center;
    padding: 0 var(--space-2);
    gap: var(--space-1);
  "
>
  <input
    class="search-bar-input"
    type="text"
    placeholder="Search commits…"
    bind:value={inputValue}
    oninput={handleInput}
    onkeydown={handleKeydown}
    use:autofocus
    style="
      flex: 1;
      border: none;
      background: transparent;
      font-size: 13px;
      color: var(--color-text);
      outline: none;
      min-width: 0;
    "
  />

  {#if query.length > 0}
    <span
      style="
        flex-shrink: 0;
        font-size: 11px;
        color: var(--color-text-muted);
        white-space: nowrap;
      "
    >
      {#if totalMatches > 0}
        {currentIndex + 1} of {totalMatches}
      {:else}
        0 matches
      {/if}
    </span>
  {/if}

  <button
    onclick={onprev}
    disabled={totalMatches === 0}
    style="
      border: none;
      background: transparent;
      cursor: pointer;
      padding: var(--space-1);
      border-radius: var(--radius);
      color: var(--color-text-muted);
      display: flex;
      align-items: center;
      opacity: {totalMatches === 0 ? '0.3' : '1'};
      pointer-events: {totalMatches === 0 ? 'none' : 'auto'};
    "
    class="search-btn"
  >
    <ChevronUp size={14} />
  </button>

  <button
    onclick={onnext}
    disabled={totalMatches === 0}
    style="
      border: none;
      background: transparent;
      cursor: pointer;
      padding: var(--space-1);
      border-radius: var(--radius);
      color: var(--color-text-muted);
      display: flex;
      align-items: center;
      opacity: {totalMatches === 0 ? '0.3' : '1'};
      pointer-events: {totalMatches === 0 ? 'none' : 'auto'};
    "
    class="search-btn"
  >
    <ChevronDown size={14} />
  </button>

  <button
    onclick={onclose}
    style="
      border: none;
      background: transparent;
      cursor: pointer;
      padding: var(--space-1);
      border-radius: var(--radius);
      color: var(--color-text-muted);
      display: flex;
      align-items: center;
    "
    class="search-btn"
  >
    <X size={14} />
  </button>
</div>

<style>
  .search-btn:hover {
    background: var(--bg-hover);
  }
</style>
