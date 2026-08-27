<script lang="ts">
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
  ">
    {remoteName}
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
      />
    </div>
  {/each}
</div>
