<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Tag from "@lucide/svelte/icons/tag";
import { visibilityVerb } from "../lib/ref-visibility.js";
import Row, { type RowTone } from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
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

let tone: RowTone = $derived(
	isHead ? "current" : isLoading || hidden ? "muted" : "plain",
);

function openMenu(e: MouseEvent) {
	if (!oncontextmenu) return;

	e.preventDefault();
	oncontextmenu(e);
}
</script>

<!--
	The eye leaves the row when idle, so the name gets the full width instead of
	truncating against a gutter for an icon that is not there, following VS Code's
	SCM view. A hidden ref keeps it: the eye is the only thing saying the ref is
	hidden, so it cannot depend on the pointer being there.
-->
{#snippet eye()}
	<RowAction
		data-testid="branch-row-visibility-btn"
		onclick={() => ontogglevisibility?.()}
		oncontextmenu={openMenu}
		aria-label="{visibilityVerb(hidden)} {name}"
	>
		<VisibilityIcon {hidden} />
	</RowAction>
{/snippet}

<div data-testid="branch-row" data-hidden={hidden}>
	<Row
		{tone}
		reveal={hidden ? "always" : "hover"}
		aria-label={name}
		onclick={() => onclick?.()}
		ondblclick={() => ondblclick?.()}
		oncontextmenu={openMenu}
		actions={ontogglevisibility ? eye : undefined}
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
	</Row>

	{#if isError}
		<div
			class="error-banner text-small leading-normal py-2 px-3 mt-0 mx-2 mb-1 rounded"
		>
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
