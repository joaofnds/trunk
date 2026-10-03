<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Plus from "@lucide/svelte/icons/plus";
import type { Snippet } from "svelte";
import { type GroupState, visibilityVerb } from "../lib/ref-visibility.js";
import RowAction from "../lib/ui/RowAction.svelte";
import VisibilityIcon from "./VisibilityIcon.svelte";

interface Props {
	label: string;
	count: number;
	expanded: boolean;
	ontoggle: () => void;
	showCreateButton?: boolean;
	oncreate?: () => void;
	createLabel?: string;
	/**
	 * How much of this section is hidden, derived from its rows so the icon can never
	 * contradict them. Pass nothing when the section does not offer a toggle.
	 */
	groupState?: GroupState;
	ontogglevisibility?: () => void;
	children: Snippet;
}

let {
	label,
	count,
	expanded,
	ontoggle,
	showCreateButton = false,
	oncreate,
	createLabel = "Create new branch",
	groupState = "none",
	ontogglevisibility,
	children,
}: Props = $props();

let allHidden = $derived(groupState === "all");
</script>

<div data-testid="branch-section-{label.toLowerCase()}">
	<!-- Section header -->
	<div
		data-testid="branch-section-header"
		role="button"
		tabindex="0"
		onclick={ontoggle}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggle(); }}
		class="h-bar py-0 pr-2 pl-3 flex flex-row items-center cursor-pointer"
	>
		<span class="text-text-muted inline-flex items-center mr-1">
			{#if expanded}
				<ChevronDown size={12} />
			{:else}
				<ChevronRight size={12} />
			{/if}
		</span>
		<span
			class="text-text-muted text-caption font-semibold tracking-widest uppercase flex-1"
		>
			{`${label} (${count})`}
		</span>
		{#if showCreateButton}
			<RowAction
				tone="text"
				data-testid="branch-section-create-btn"
				onclick={(e) => { e.stopPropagation(); oncreate?.(); }}
				aria-label={createLabel}
			>
				<Plus size={12} />
			</RowAction>
		{/if}
		{#if ontogglevisibility}
			<RowAction
				tone="muted"
				data-testid="branch-section-visibility-btn"
				onclick={(e) => { e.stopPropagation(); ontogglevisibility?.(); }}
				aria-label="{visibilityVerb(allHidden)} all {label} refs"
				data-group-state={groupState}
			>
				<VisibilityIcon hidden={allHidden} />
			</RowAction>
		{/if}
	</div>

	<!-- Section content -->
	{#if expanded}
		{@render children()}
	{/if}
</div>
