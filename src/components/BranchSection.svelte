<script lang="ts">
  import type { Snippet } from 'svelte';

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

<div>
  <!-- Section header -->
  <div
    role="button"
    tabindex="0"
    onclick={ontoggle}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggle(); }}
    style="
      height: 28px;
      border-bottom: 1px solid var(--color-border);
      padding: 0 8px;
      display: flex;
      flex-direction: row;
      align-items: center;
      cursor: pointer;
      user-select: none;
    "
  >
    <span style="color: var(--color-text-muted); font-size: 10px; margin-right: 4px;">
      {expanded ? '▼' : '▶'}
    </span>
    <span style="color: var(--color-text); font-size: 12px; font-weight: 500; flex: 1;">
      {label} ({count})
    </span>
    {#if showCreateButton}
      <button
        onclick={(e) => { e.stopPropagation(); oncreate?.(); }}
        style="color: var(--color-text-muted); font-size: 14px; background: none; border: none; cursor: pointer; padding: 0 4px;"
        aria-label="Create new branch"
      >
        +
      </button>
    {/if}
  </div>

  <!-- Section content -->
  {#if expanded}
    {@render children()}
  {/if}
</div>
