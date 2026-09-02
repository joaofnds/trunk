<script lang="ts">
import Eye from "@lucide/svelte/icons/eye";
import EyeOff from "@lucide/svelte/icons/eye-off";
import BranchRow from "./BranchRow.svelte";

interface Props {
	remoteName: string;
	branches: string[];
	checkingOut: string | null;
	errorBranch: string | null;
	errorText: string;
	oncheckout: (fullName: string) => void;
	ondblclick?: (fullName: string) => void;
	oncontextmenu?: (e: MouseEvent, fullName: string) => void;
	/** Whether this whole remote is hidden from the graph. */
	hidden?: boolean;
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
	hidden = false,
	hiddenBranches = {},
	ontogglevisibility,
	ontogglebranchvisibility,
}: Props = $props();
</script>

<div>
  <!-- Remote name sub-header -->
  <div style="
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
    font-size: 11px;
    color: var(--fg-3);
    font-weight: 500;
    font-family: var(--font-mono);
    display: flex;
    align-items: center;
  ">
    <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;">{remoteName}</span>
    {#if ontogglevisibility}
      <button
        data-testid="remote-group-visibility-btn"
        onclick={() => ontogglevisibility?.()}
        style="flex-shrink: 0; color: var(--fg-3); background: none; border: none; cursor: pointer; padding: 0 var(--space-1); display: inline-flex; align-items: center;"
        aria-label="{hidden ? 'Show' : 'Hide'} all {remoteName} branches"
      >
        {#if hidden}<EyeOff size={12} />{:else}<Eye size={12} />{/if}
      </button>
    {/if}
  </div>

  <!-- Branch rows for this remote -->
  {#each branches as branch (branch)}
    <div style="padding-left: var(--space-3); overflow: hidden;">
      <BranchRow
        name={branch}
        kind="remote"
        isLoading={checkingOut === remoteName + '/' + branch}
        isError={errorBranch === remoteName + '/' + branch}
        {errorText}
        onclick={() => oncheckout(remoteName + '/' + branch)}
        ondblclick={() => ondblclick?.(remoteName + '/' + branch)}
        oncontextmenu={(e) => oncontextmenu?.(e, remoteName + '/' + branch)}
        hidden={hidden || (hiddenBranches[remoteName + '/' + branch] ?? false)}
        ontogglevisibility={ontogglebranchvisibility
          ? () => ontogglebranchvisibility?.(remoteName + '/' + branch)
          : undefined}
      />
    </div>
  {/each}
</div>
