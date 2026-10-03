<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Tag from "@lucide/svelte/icons/tag";
import { visibilityVerb } from "../lib/ref-visibility.js";
import VisibilityIcon from "./VisibilityIcon.svelte";

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
	/** Whether this ref is hidden from the graph. */
	hidden?: boolean;
	/** Omitted by a row that cannot be hidden, such as HEAD's own branch. */
	ontogglevisibility?: () => void;
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
	hidden = false,
	ontogglevisibility,
}: Props = $props();

let hovered = $state(false);
let focused = $state(false);

/**
 * Whether the trailing action occupies the row.
 *
 * Idle rows drop it out of the flow entirely, so the name gets the full width instead of
 * truncating against a reserved gutter for an icon that is not there. Following VS Code's
 * SCM view, which is the same problem in the same shape: a git ref list in a narrow pane.
 *
 * Focus counts alongside hover, or the control would be unreachable by keyboard. A hidden
 * ref keeps it permanently: the eye is the only thing saying the ref is hidden, so it
 * cannot depend on the pointer being there.
 */
let actionShown = $derived(hovered || focused || hidden);
</script>

<div
	data-testid="branch-row"
	data-hidden={hidden}
	data-action-shown={actionShown}
>
	<div
		role="button"
		tabindex="0"
		onclick={() => onclick?.()}
		ondblclick={() => ondblclick?.()}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); }}
		oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
		onmouseenter={() => (hovered = true)}
		onmouseleave={() => (hovered = false)}
		onfocusin={() => (focused = true)}
		onfocusout={() => (focused = false)}
		aria-label={name}
		class="h-row my-0 mx-2 py-0 px-2 rounded flex items-center overflow-hidden cursor-pointer text-callout"
		style:background={isHead ? 'color-mix(in oklch, var(--color-accent) 10%, transparent)' : hovered ? 'var(--color-hover)' : 'transparent'}
		style:box-shadow={isHead ? 'inset 0 0 0 1px color-mix(in oklch, var(--color-accent) 28%, transparent)' : 'none'}
		style:color={isHead ? 'var(--color-text-strong)' : isLoading || hidden ? 'var(--color-text-muted)' : 'var(--color-text)'}
		style:font-weight={isHead ? '600' : 'normal'}
	>
		{#if kind === 'tag'}
			<span class="shrink-0 inline-flex items-center mr-2 text-text-subtle">
				<Tag size={12} />
			</span>
		{:else}
			<span
				class="shrink-0 dot rounded-full mr-2"
				style:background={isHead ? 'var(--color-accent)' : 'var(--color-text-disabled)'}
			></span>
		{/if}
		<span
			title={name}
			class="block overflow-hidden whitespace-nowrap text-ellipsis min-w-0 flex-1"
			>{name}{isLoading ? ' …' : ''}</span
		>
		{#if ahead > 0 || behind > 0}
			<span
				class="shrink-0 font-mono text-caption text-text-subtle ml-1 inline-flex items-center gap-1"
			>
				{#if ahead > 0}
					<span class="inline-flex items-center text-success"
						><ArrowUp size={11} />{ahead}</span
					>
				{/if}
				{#if behind > 0}
					<span class="inline-flex items-center ml-1 text-warning"
						><ArrowDown size={11} />{behind}</span
					>
				{/if}
			</span>
		{/if}
		{#if isHead}
			<span
				class="shrink-0 ml-1 font-mono text-caption tracking-widest text-accent"
				>HEAD</span
			>
		{/if}
		{#if ontogglevisibility}
			<button
				type="button"
				data-testid="branch-row-visibility-btn"
				onclick={(e) => { e.stopPropagation(); ontogglevisibility?.(); }}
				ondblclick={(e) => e.stopPropagation()}
				class="shrink-0 ml-1 -mr-2 text-text-subtle bg-transparent border-none cursor-pointer p-0 min-w-target min-h-target items-center justify-center"
				style:display={actionShown ? 'inline-flex' : 'none'}
				aria-label="{visibilityVerb(hidden)} {name}"
			>
				<VisibilityIcon {hidden} />
			</button>
		{/if}
	</div>

	{#if isError}
		<div class="error-banner text-small py-2 px-3 mt-0 mx-2 mb-1 rounded">
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
.dot {
	width: 6px;
	height: 6px;
}
</style>
