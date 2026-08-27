<script lang="ts">
import { ArrowDown, ArrowUp, Tag } from "@lucide/svelte";

interface Props {
	name: string;
	kind?: "local" | "remote" | "tag";
	isHead?: boolean;
	isLoading?: boolean;
	isError?: boolean;
	errorText?: string;
	ahead?: number;
	behind?: number;
	onclick?: () => void;
	ondblclick?: () => void;
	oncontextmenu?: (e: MouseEvent) => void;
}

let {
	name,
	kind = "local",
	isHead = false,
	isLoading = false,
	isError = false,
	errorText,
	ahead = 0,
	behind = 0,
	onclick,
	ondblclick,
	oncontextmenu,
}: Props = $props();

let hovered = $state(false);
</script>

<div data-testid="branch-row">
  <div
    role="button"
    tabindex="0"
    onclick={() => onclick?.()}
    ondblclick={() => ondblclick?.()}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); }}
    oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    style="
      height: var(--row-h);
      margin: 0 var(--space-2);
      padding: 0 var(--space-2);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      overflow: hidden;
      cursor: pointer;
      background: {isHead ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : hovered ? 'var(--bg-hover)' : 'transparent'};
      box-shadow: {isHead ? 'inset 0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)' : 'none'};
      color: {isHead ? 'var(--fg-0)' : isLoading ? 'var(--color-text-muted)' : 'var(--color-text)'};
      font-weight: {isHead ? '600' : 'normal'};
      font-size: 12px;
    "
  >
    {#if kind === 'tag'}
      <span style="flex-shrink: 0; display: inline-flex; align-items: center; margin-right: 6px; color: var(--fg-3);">
        <Tag size={12} />
      </span>
    {:else}
      <span style="flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; margin-right: 8px; background: {isHead ? 'var(--accent)' : 'var(--fg-4)'};"></span>
    {/if}
    <span style="
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    ">{name}{isLoading ? ' …' : ''}</span>
    {#if ahead > 0 || behind > 0}
      <span style="flex-shrink: 0; font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); margin-left: 4px; display: inline-flex; align-items: center; gap: var(--space-1);">
        {#if ahead > 0}<span style="display: inline-flex; align-items: center; color: var(--ok);"><ArrowUp size={11} />{ahead}</span>{/if}
        {#if behind > 0}<span style="display: inline-flex; align-items: center; margin-left: 2px; color: var(--warn);"><ArrowDown size={11} />{behind}</span>{/if}
      </span>
    {/if}
    {#if isHead}
      <span style="flex-shrink: 0; margin-left: 4px; font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.08em; color: var(--accent);">HEAD</span>
    {/if}
  </div>

  {#if isError}
    <div class="error-banner" style="font-size: 11px; padding: var(--space-2) var(--space-3); margin: 0 var(--space-2) var(--space-1); border-radius: var(--radius);">
      {errorText ?? 'Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.'}
    </div>
  {/if}
</div>

<style>
  .error-banner {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }
</style>
