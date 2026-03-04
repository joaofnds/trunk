<script lang="ts">
  interface Props {
    repoName: string;
    onclose: () => void;
  }

  let { repoName, onclose }: Props = $props();
</script>

<!-- Tab bar layout ready for multi-tab in v0.2 — single tab only in v0.1 -->
<div
  class="flex items-center flex-shrink-0"
  style="
    height: 32px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  "
>
  <div
    class="flex items-center gap-1 h-full px-3 text-xs font-medium"
    style="
      color: var(--color-text);
      border-bottom: 2px solid var(--color-accent);
      background: var(--color-bg);
    "
  >
    <span class="truncate max-w-[200px]">{repoName}</span>
    <button
      onclick={onclose}
      class="flex items-center justify-center w-4 h-4 rounded-sm transition-colors ml-1"
      style="color: var(--color-text-muted);"
      aria-label="Close repository"
      title="Close repository"
    >
      ×
    </button>
  </div>
</div>
