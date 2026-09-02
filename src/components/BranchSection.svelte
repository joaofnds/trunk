<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Eye from "@lucide/svelte/icons/eye";
import EyeOff from "@lucide/svelte/icons/eye-off";
import Plus from "@lucide/svelte/icons/plus";
import type { Snippet } from "svelte";

interface Props {
	label: string;
	count: number;
	expanded: boolean;
	ontoggle: () => void;
	showCreateButton?: boolean;
	oncreate?: () => void;
	/** Whether every ref in this section is hidden from the graph. */
	hidden?: boolean;
	/** Omitted by a section that offers no visibility toggle. */
	ontogglevisibility?: () => void;
	children: Snippet;
}

let {
	label,
	count,
	expanded,
	ontoggle,
	showCreateButton = false,
	oncreate,
	hidden = false,
	ontogglevisibility,
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
      height: var(--bar-h);
      padding: 0 var(--space-3);
      display: flex;
      flex-direction: row;
      align-items: center;
      cursor: pointer;
    "
  >
    <span style="color: var(--fg-2); display: inline-flex; align-items: center; margin-right: var(--space-1);">
      {#if expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
    </span>
    <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; flex: 1;">
      {label} ({count})
    </span>
    {#if ontogglevisibility}
      <button
        data-testid="branch-section-visibility-btn"
        onclick={(e) => { e.stopPropagation(); ontogglevisibility?.(); }}
        style="color: var(--fg-2); background: none; border: none; cursor: pointer; padding: 0 var(--space-1); display: inline-flex; align-items: center;"
        aria-label="{hidden ? 'Show' : 'Hide'} all {label} refs"
      >
        {#if hidden}<EyeOff size={12} />{:else}<Eye size={12} />{/if}
      </button>
    {/if}
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
