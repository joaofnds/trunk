<script lang="ts">
  import type { FileStatus, FileStatusType } from '../lib/types.js';

  interface Props {
    file: FileStatus;
    isLoading?: boolean;
    actionLabel: string;
    onaction: () => void;
  }

  let {
    file,
    isLoading = false,
    actionLabel,
    onaction,
  }: Props = $props();

  let hovered = $state(false);

  interface StatusIcon {
    symbol: string;
    color: string;
  }

  const STATUS_ICONS: Record<FileStatusType, StatusIcon> = {
    New:        { symbol: '+',  color: '#4ade80' },
    Modified:   { symbol: '✎', color: '#fb923c' },
    Deleted:    { symbol: '−', color: '#f87171' },
    Renamed:    { symbol: '→', color: '#60a5fa' },
    Typechange: { symbol: '⇄', color: '#c084fc' },
    Conflicted: { symbol: '!', color: '#facc15' },
  };

  let icon = $derived(STATUS_ICONS[file.status] ?? { symbol: '?', color: 'var(--color-text-muted)' });
</script>

<div
  role="listitem"
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  style="
    height: 26px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: {hovered ? 'var(--color-surface)' : 'transparent'};
    color: {isLoading ? 'var(--color-text-muted)' : 'var(--color-text)'};
  "
>
  <!-- Status icon -->
  <span style="
    display: inline-block;
    width: 14px;
    min-width: 14px;
    font-size: 12px;
    font-weight: 700;
    color: {isLoading ? 'var(--color-text-muted)' : icon.color};
    text-align: center;
  ">
    {icon.symbol}
  </span>

  <!-- Filename -->
  <span style="
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  ">
    {file.path}
  </span>

  <!-- Hover action button (hidden during loading) -->
  {#if hovered && !isLoading}
    <button
      onclick={(e) => { e.stopPropagation(); onaction(); }}
      aria-label={actionLabel === '+' ? 'Stage file' : 'Unstage file'}
      style="
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-accent);
        font-size: 14px;
        padding: 0 4px;
        line-height: 1;
      "
    >
      {actionLabel}
    </button>
  {/if}
</div>
