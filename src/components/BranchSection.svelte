<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Plus from "@lucide/svelte/icons/plus";
import type { Snippet } from "svelte";
import { type GroupState, visibilityVerb } from "../lib/ref-visibility.js";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import VisibilityIcon from "./VisibilityIcon.svelte";

interface Props {
	label: string;
	count: number;
	filteredFrom?: number;
	filterQuery?: string;
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
	filteredFrom,
	filterQuery = "",
	expanded,
	ontoggle,
	showCreateButton = false,
	oncreate,
	createLabel = "Create new branch",
	groupState = "none",
	ontogglevisibility,
	children,
}: Props = $props();

let open = $derived(filterQuery && count > 0 ? true : expanded);

function toggle() {
	if (filterQuery) open = !open;
	else ontoggle();
}

let allHidden = $derived(groupState === "all");
</script>

{#snippet actions()}
	{#if showCreateButton}
		<RowAction
			tone="text"
			data-testid="branch-section-create-btn"
			onclick={() => {
				if (filterQuery) open = true;
				oncreate?.();
			}}
			aria-label={createLabel}
		>
			<Plus size={12} />
		</RowAction>
	{/if}
	{#if ontogglevisibility && count > 0}
		<RowAction
			tone="muted"
			data-testid="branch-section-visibility-btn"
			onclick={() => ontogglevisibility?.()}
			aria-label="{visibilityVerb(allHidden)} {filteredFrom === undefined
				? "all"
				: "matching"} {label} refs"
			data-group-state={groupState}
		>
			<VisibilityIcon hidden={allHidden} />
		</RowAction>
	{/if}
{/snippet}

<div data-testid="branch-section-{label.toLowerCase()}">
	<Row
		variant="header"
		wrapActions
		reveal="always"
		data-testid="branch-section-header"
		onclick={toggle}
		aria-expanded={open}
		{actions}
	>
		<span class="text-text-muted inline-flex items-center mr-1">
			{#if open}
				<ChevronDown size={12} />
			{:else}
				<ChevronRight size={12} />
			{/if}
		</span>
		<span class="text-callout font-semibold text-text min-w-0 wrap-anywhere">
			{label} ({count}{filteredFrom === undefined ? "" : ` of ${filteredFrom}`})
		</span>
	</Row>

	<!-- Section content -->
	{#if open}
		{@render children()}
	{/if}
</div>
