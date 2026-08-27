<script lang="ts">
import { ChevronDown, ChevronRight, Plus } from "@lucide/svelte";
import type { Snippet } from "svelte";

interface Props {
	label: string;
	count: number;
	expanded: boolean;
	ontoggle: () => void;
	showCreateButton?: boolean;
	oncreate?: () => void;
	children: Snippet;
}

let {
	label,
	count,
	expanded,
	ontoggle,
	showCreateButton = false,
	oncreate,
	children,
}: Props = $props();
</script>

<div data-testid="branch-section-{label.toLowerCase()}">
  <!-- Section header -->
  <div
    role="button"
    tabindex="0"
    onclick={ontoggle}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggle(); }}
    style="
      padding: var(--space-3) var(--space-3) var(--space-2);
      display: flex;
      flex-direction: row;
      align-items: center;
      cursor: pointer;
    "
  >
    <span style="color: var(--fg-2); display: inline-flex; align-items: center; margin-right: 4px;">
      {#if expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
    </span>
    <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; flex: 1;">
      {label} ({count})
    </span>
    {#if showCreateButton}
      <button
        data-testid="branch-section-create-btn"
        onclick={(e) => { e.stopPropagation(); oncreate?.(); }}
        style="color: var(--fg-1); background: none; border: none; cursor: pointer; padding: 0 var(--space-1); display: inline-flex; align-items: center;"
        aria-label="Create new branch"
      >
        <Plus size={12} />
      </button>
    {/if}
  </div>

  <!-- Section content -->
  {#if expanded}
    {@render children()}
  {/if}
</div>
