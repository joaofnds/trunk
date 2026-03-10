<script lang="ts">
  import type { ColumnVisibility } from '../lib/store.js';

  interface Props {
    x: number;
    y: number;
    visibility: ColumnVisibility;
    onchange: (v: ColumnVisibility) => void;
    onclose: () => void;
  }

  let { x, y, visibility, onchange, onclose }: Props = $props();

  let menuEl: HTMLDivElement | undefined = $state();

  const columns: { key: keyof ColumnVisibility; label: string }[] = [
    { key: 'ref', label: 'Branch/Tag' },
    { key: 'graph', label: 'Graph' },
    { key: 'message', label: 'Message' },
    { key: 'author', label: 'Author' },
    { key: 'date', label: 'Date' },
    { key: 'sha', label: 'SHA' },
  ];

  function toggle(key: keyof ColumnVisibility) {
    if (key === 'message') return;
    onchange({ ...visibility, [key]: !visibility[key] });
  }

  function handleWindowClick(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onclose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    }
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<div
  bind:this={menuEl}
  class="header-context-menu"
  style="left: {x}px; top: {y}px;"
>
  {#each columns as col}
    <label
      class="menu-row"
      class:disabled={col.key === 'message'}
    >
      <input
        type="checkbox"
        checked={visibility[col.key]}
        disabled={col.key === 'message'}
        onchange={() => toggle(col.key)}
      />
      <span>{col.label}</span>
      {#if col.key === 'message'}
        <span class="required-note">(required)</span>
      {/if}
    </label>
  {/each}
</div>

<style>
  .header-context-menu {
    position: fixed;
    z-index: 100;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 160px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .menu-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--color-text);
    cursor: pointer;
    user-select: none;
  }

  .menu-row:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .menu-row.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .menu-row.disabled:hover {
    background: transparent;
  }

  .required-note {
    font-size: 10px;
    color: var(--color-text-muted);
    margin-left: auto;
  }

  input[type='checkbox'] {
    accent-color: var(--color-accent);
  }
</style>
