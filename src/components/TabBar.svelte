<script lang="ts">
  interface Props {
    repoName: string;
    onclose: () => void;
  }

  let { repoName, onclose }: Props = $props();
</script>

<div
  class="flex items-center gap-1 h-full px-3 text-xs font-medium flex-shrink-0"
  style="
    color: var(--color-text);
    border-right: 1px solid var(--color-border);
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
