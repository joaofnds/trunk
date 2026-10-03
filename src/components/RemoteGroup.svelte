<script lang="ts">
import { type GroupState, visibilityVerb } from "../lib/ref-visibility.js";
import RowAction from "../lib/ui/RowAction.svelte";
import BranchRow from "./BranchRow.svelte";
import VisibilityIcon from "./VisibilityIcon.svelte";

interface Props {
	remoteName: string;
	branches: string[];
	checkingOut: string | null;
	errorBranch: string | null;
	errorText: string;
	oncheckout: (fullName: string) => void;
	ondblclick?: (fullName: string) => void;
	oncontextmenu?: (e: MouseEvent, fullName: string) => void;
	/**
	 * How much of this remote is hidden, derived from its rows so the icon can never
	 * contradict them.
	 */
	groupState?: GroupState;
	/** Whether each branch under it is hidden, keyed by branch name. */
	hiddenBranches?: Record<string, boolean>;
	ontogglevisibility?: () => void;
	ontogglebranchvisibility?: (fullName: string) => void;
}

let {
	remoteName,
	branches,
	checkingOut,
	errorBranch,
	errorText,
	oncheckout,
	ondblclick,
	oncontextmenu,
	groupState = "none",
	hiddenBranches = {},
	ontogglevisibility,
	ontogglebranchvisibility,
}: Props = $props();

let allHidden = $derived(groupState === "all");
</script>

<div>
	<!-- Remote name sub-header -->
	<div
		data-testid="remote-group-subheader"
		class="h-bar py-0 pr-2 pl-4 text-small text-text-subtle font-medium font-mono flex items-center"
	>
		<span class="flex-1 min-w-0 overflow-hidden text-ellipsis"
			>{remoteName}</span
		>
		{#if ontogglevisibility}
			<RowAction
				data-testid="remote-group-visibility-btn"
				onclick={() => ontogglevisibility?.()}
				aria-label="{visibilityVerb(allHidden)} all {remoteName} branches"
				data-group-state={groupState}
			>
				<VisibilityIcon hidden={allHidden} />
			</RowAction>
		{/if}
	</div>

	<!-- Branch rows for this remote -->
	{#each branches as branch (branch)}
		{@const fullName = `${remoteName}/${branch}`}
		<div class="pl-3 overflow-hidden">
			<BranchRow
				name={branch}
				kind="remote"
				isLoading={checkingOut === fullName}
				isError={errorBranch === fullName}
				{errorText}
				onclick={() => oncheckout(fullName)}
				ondblclick={() => ondblclick?.(fullName)}
				oncontextmenu={(e) => oncontextmenu?.(e, fullName)}
				hidden={hiddenBranches[fullName] ?? false}
				ontogglevisibility={ontogglebranchvisibility
          ? () => ontogglebranchvisibility?.(fullName)
          : undefined}
			/>
		</div>
	{/each}
</div>
