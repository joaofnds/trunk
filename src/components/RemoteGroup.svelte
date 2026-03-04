<script lang="ts">
  import BranchRow from './BranchRow.svelte';

  interface Props {
    remoteName: string;
    branches: string[];
    checkingOut: string | null;
    errorBranch: string | null;
    errorText: string;
    oncheckout: (fullName: string) => void;
  }

  let {
    remoteName,
    branches,
    checkingOut,
    errorBranch,
    errorText,
    oncheckout,
  }: Props = $props();
</script>

<div>
  <!-- Remote name sub-header -->
  <div style="
    padding: 2px 8px 2px 16px;
    font-size: 11px;
    color: var(--color-text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  ">
    {remoteName}
  </div>

  <!-- Branch rows for this remote -->
  {#each branches as branch (branch)}
    <div style="padding-left: 12px; overflow: hidden;">
      <BranchRow
        name={branch}
        isLoading={checkingOut === remoteName + '/' + branch}
        isError={errorBranch === remoteName + '/' + branch}
        {errorText}
        onclick={() => oncheckout(remoteName + '/' + branch)}
      />
    </div>
  {/each}
</div>
