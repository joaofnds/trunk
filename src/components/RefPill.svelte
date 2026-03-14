<script lang="ts">
  import type { RefLabel } from '../lib/types.js';

  interface Props {
    refs: RefLabel[];
    showAll?: boolean;
    expanded?: boolean;
    maxWidth?: number;
  }

  let { refs, showAll = false, expanded = false, maxWidth = 0 }: Props = $props();

  const base =
    'inline-flex items-center rounded-full px-1.5 py-0 text-[11px] leading-5 whitespace-nowrap font-medium';

  const baseCollapsed =
    'inline-flex items-center rounded-full px-1.5 py-0 text-[11px] leading-5 font-medium overflow-hidden text-ellipsis whitespace-nowrap';

  function pillClasses(ref: RefLabel, expanded: boolean = false): string {
    const b = expanded ? base : baseCollapsed;
    if (ref.is_head) {
      return `${b} font-bold`;
    }
    return b;
  }

  function pillStyle(ref: RefLabel, bright: boolean = false): string {
    const bg = `background: var(--lane-${ref.color_index % 8})`;
    const color = 'color: white';
    const opacity = !bright && isRemoteOnly(ref) ? 'opacity: 0.5' : '';
    const brightness = ref.is_head || bright ? '' : 'filter: brightness(0.75)';
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

{#if showAll}
  <div class="flex flex-col gap-0.5">
    {#each refs as ref}
      <span class="{pillClasses(ref, true)} w-full" style={pillStyle(ref)}>{pillPrefix(ref)}{ref.short_name}</span>
    {/each}
  </div>
{:else if refs.length > 0}
  <span
    class={pillClasses(refs[0], expanded)}
    style="{pillStyle(refs[0], expanded)}; transition: filter 150ms ease-out;{expanded || !maxWidth ? '' : ` max-width: ${maxWidth - 16}px;`}"
  >{pillPrefix(refs[0])}{refs[0].short_name}</span>
{/if}
