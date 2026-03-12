<script lang="ts">
  interface Props {
    name: string;
    isHead?: boolean;
    isLoading?: boolean;
    isError?: boolean;
    errorText?: string;
    ahead?: number;
    behind?: number;
    onclick?: () => void;
  }

  let {
    name,
    isHead = false,
    isLoading = false,
    isError = false,
    errorText,
    ahead = 0,
    behind = 0,
    onclick,
  }: Props = $props();

  let hovered = $state(false);
</script>

<div>
  <div
    role="button"
    tabindex="0"
    onclick={() => onclick?.()}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); }}
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    style="
      height: 26px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      overflow: hidden;
      cursor: pointer;
      background: {hovered ? 'var(--color-surface)' : 'transparent'};
      color: {isHead ? 'var(--color-accent)' : isLoading ? 'var(--color-text-muted)' : 'var(--color-text)'};
      font-weight: {isHead ? '600' : 'normal'};
      font-size: 13px;
    "
  >
    <span style="
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    ">{name}{isLoading ? ' …' : ''}</span>
    {#if behind > 0 || ahead > 0}
      <span style="flex-shrink: 0; font-size: 11px; color: var(--color-text-muted); margin-left: 4px;">
        {#if behind > 0}<span>{'\u2193'}{behind}</span>{/if}
        {#if ahead > 0}<span style="margin-left: 2px;">{'\u2191'}{ahead}</span>{/if}
      </span>
    {/if}
  </div>

  {#if isError}
    <div style="background: #3d1c1c; border: 1px solid #6b2a2a; color: #f87171; font-size: 11px; padding: 6px 10px; margin: 0 8px 4px; border-radius: 3px;">
      {errorText ?? 'Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.'}
    </div>
  {/if}
</div>
