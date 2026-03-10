<script lang="ts">
  import type { RefLabel } from '../lib/types.js';

  interface Props {
    refs: RefLabel[];
  }

  let { refs }: Props = $props();

  const base =
    'inline-flex items-center rounded-full px-1.5 py-0 text-[11px] leading-5 whitespace-nowrap max-w-[100px] truncate font-medium';

  function pillClasses(ref: RefLabel): string {
    if (ref.is_head) {
      return `${base} font-bold`;
    }
    return base;
  }

  function pillStyle(ref: RefLabel): string {
    const bg = `background: var(--lane-${ref.color_index % 8})`;
    const color = 'color: white';
    const opacity = isRemoteOnly(ref) ? 'opacity: 0.5' : '';
    const brightness = ref.is_head ? '' : 'filter: brightness(0.75)';
    return [bg, color, opacity, brightness].filter(Boolean).join('; ');
  }

  function isRemoteOnly(ref: RefLabel): boolean {
    if (ref.ref_type !== 'RemoteBranch') return false;
    return !refs.some(
      (r) => r !== ref && (r.ref_type === 'LocalBranch' || r.ref_type === 'Tag')
    );
  }

  function pillPrefix(ref: RefLabel): string {
    if (ref.ref_type === 'Tag') return '\u25C6 ';
    if (ref.ref_type === 'Stash') return '\u2691 ';
    return '';
  }
</script>

{#if refs.length > 0}
  <span class={pillClasses(refs[0])} style={pillStyle(refs[0])}>{pillPrefix(refs[0])}{refs[0].short_name}</span>
{/if}
