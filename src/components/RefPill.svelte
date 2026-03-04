<script lang="ts">
  import type { RefLabel } from '../lib/types.js';

  interface Props {
    refs: RefLabel[];
  }

  let { refs }: Props = $props();

  function pillClasses(ref: RefLabel): string {
    const base =
      'inline-flex items-center rounded-full px-1.5 py-0 text-[11px] leading-5 whitespace-nowrap max-w-[100px] truncate';
    if (ref.is_head) {
      return `${base} bg-[var(--color-accent)] text-white font-bold`;
    }
    switch (ref.ref_type) {
      case 'LocalBranch':
        return `${base} bg-green-700 text-green-100`;
      case 'RemoteBranch':
        return `${base} bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]`;
      case 'Tag':
        return `${base} bg-green-700 text-green-100`;
      case 'Stash':
        return `${base} bg-[var(--color-surface)] text-[var(--color-text-muted)]`;
    }
  }

  function pillPrefix(ref: RefLabel): string {
    if (ref.ref_type === 'Tag') return '◆ ';
    if (ref.ref_type === 'Stash') return '⚑ ';
    return '';
  }
</script>

{#if refs.length > 0}
  <span class={pillClasses(refs[0])}>{pillPrefix(refs[0])}{refs[0].short_name}</span>
  {#if refs.length > 1}
    <span
      class="text-[11px] text-[var(--color-text-muted)] ml-1 cursor-default"
      title={refs.slice(1).map((r) => r.short_name).join(', ')}
    >
      +{refs.length - 1}
    </span>
  {/if}
{/if}
