<script lang="ts">
  import type { RefsResponse } from '../lib/types.js';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import BranchSection from './BranchSection.svelte';
  import BranchRow from './BranchRow.svelte';
  import RemoteGroup from './RemoteGroup.svelte';

  interface Props {
    repoPath: string;
    onrefreshed?: () => void;
  }

  let { repoPath, onrefreshed }: Props = $props();

  let refs = $state<RefsResponse | null>(null);
  let loading = $state(false);
  let loadSeq = $state(0);
  let search = $state('');
  let checkingOutBranch = $state<string | null>(null);
  let checkoutError = $state<{ branch: string; message: string } | null>(null);
  let localExpanded = $state(true);
  let remoteExpanded = $state(false);
  let tagsExpanded = $state(false);
  let stashesExpanded = $state(false);
  let showCreateInput = $state(false);
  let newBranchName = $state('');
  let createError = $state<string | null>(null);

  let filteredLocal = $derived(
    search
      ? (refs?.local ?? []).filter(b => b.name.toLowerCase().includes(search.toLowerCase()))
      : (refs?.local ?? [])
  );

  let filteredRemote = $derived(
    search
      ? (refs?.remote ?? []).filter(b => b.name.toLowerCase().includes(search.toLowerCase()))
      : (refs?.remote ?? [])
  );

  let filteredTags = $derived(
    search
      ? (refs?.tags ?? []).filter(t => t.short_name.toLowerCase().includes(search.toLowerCase()))
      : (refs?.tags ?? [])
  );

  let filteredStashes = $derived(
    search
      ? (refs?.stashes ?? []).filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
      : (refs?.stashes ?? [])
  );

  // Group remote branches by remote name: { "origin": ["main", "dev"] }
  let remoteGroups = $derived(
    filteredRemote.reduce<Record<string, string[]>>((acc, b) => {
      const slash = b.name.indexOf('/');
      const remote = slash >= 0 ? b.name.slice(0, slash) : 'unknown';
      const short = slash >= 0 ? b.name.slice(slash + 1) : b.name;
      (acc[remote] ??= []).push(short);
      return acc;
    }, {})
  );

  // Load refs on mount and when repoPath changes
  $effect(() => {
    const path = repoPath;
    loading = true;
    loadRefs(path);
  });

  // Dismiss error when search changes
  $effect(() => {
    if (search) checkoutError = null;
  });

  async function loadRefs(path: string) {
    const seq = ++loadSeq;
    loading = true;
    try {
      const result = await safeInvoke<RefsResponse>('list_refs', { path });
      if (seq === loadSeq) {
        refs = result;
      }
    } catch {
      if (seq === loadSeq) {
        refs = null;
      }
    } finally {
      if (seq === loadSeq) {
        loading = false;
      }
    }
  }

  async function handleCheckout(branchName: string) {
    // Dismiss any existing error first
    checkoutError = null;
    checkingOutBranch = branchName;
    try {
      await safeInvoke<void>('checkout_branch', { path: repoPath, branchName });
      await loadRefs(repoPath);
      onrefreshed?.();
    } catch (e) {
      const err = e as TrunkError;
      if (err.code === 'dirty_workdir') {
        checkoutError = {
          branch: branchName,
          message: 'Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.'
        };
      }
    } finally {
      checkingOutBranch = null;
    }
  }

  async function handleCreateBranch() {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;
    createError = null;
    try {
      await safeInvoke<void>('create_branch', { path: repoPath, name: trimmed });
      showCreateInput = false;
      newBranchName = '';
      await loadRefs(repoPath);
      onrefreshed?.();
    } catch (e) {
      const err = e as TrunkError;
      createError = err.message;
    }
  }

  function autoFocus(node: HTMLElement) {
    node.focus();
    return {};
  }
</script>

<aside style="
  width: 220px;
  min-width: 220px;
  background: var(--color-bg);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
">
  <!-- Search input (sticky at top) -->
  <div style="padding: 6px 8px; border-bottom: 1px solid var(--color-border);">
    <input
      type="text"
      placeholder="Filter branches…"
      bind:value={search}
      style="
        width: 100%;
        box-sizing: border-box;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        color: var(--color-text);
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 4px;
        outline: none;
      "
    />
  </div>

  <!-- Sections (scrollable) -->
  <div style="flex: 1; overflow-y: auto;">
    <!-- Local branches (expanded by default, show + button) -->
    {#if loading || filteredLocal.length > 0 || (refs?.local.length ?? 0) > 0}
      <BranchSection
        label="Local"
        count={refs?.local.length ?? 0}
        bind:expanded={localExpanded}
        showCreateButton={true}
        oncreate={() => { showCreateInput = true; }}
      >
        {#if showCreateInput}
          <div style="padding: 2px 8px 4px;">
            <input
              type="text"
              placeholder="New branch name"
              bind:value={newBranchName}
              use:autoFocus
              style="
                width: 100%;
                box-sizing: border-box;
                background: var(--color-surface);
                border: 1px solid var(--color-accent);
                color: var(--color-text);
                font-size: 12px;
                padding: 2px 6px;
                height: 26px;
                border-radius: 3px;
                outline: none;
              "
              onkeydown={(e) => {
                if (e.key === 'Enter') handleCreateBranch();
                if (e.key === 'Escape') { showCreateInput = false; newBranchName = ''; createError = null; }
              }}
            />
            {#if createError}
              <div style="color: #f87171; font-size: 11px; margin-top: 2px;">{createError}</div>
            {/if}
          </div>
        {/if}
        {#each filteredLocal as branch (branch.name)}
          <BranchRow
            name={branch.name}
            isHead={branch.is_head}
            isLoading={checkingOutBranch === branch.name}
            isError={checkoutError?.branch === branch.name}
            errorText={checkoutError?.message}
            onclick={() => handleCheckout(branch.name)}
          />
        {/each}
      </BranchSection>
    {/if}

    <!-- Remote branches (collapsed by default, grouped by remote) -->
    {#if (refs?.remote.length ?? 0) > 0}
      <BranchSection
        label="Remote"
        count={refs?.remote.length ?? 0}
        bind:expanded={remoteExpanded}
      >
        {#each Object.entries(remoteGroups) as [remoteName, branches] (remoteName)}
          <RemoteGroup
            {remoteName}
            {branches}
            checkingOut={checkingOutBranch}
            errorBranch={checkoutError?.branch ?? null}
            errorText={checkoutError?.message ?? ''}
            oncheckout={(fullName) => handleCheckout(fullName)}
          />
        {/each}
      </BranchSection>
    {/if}

    <!-- Tags (collapsed by default; hidden if empty) -->
    {#if (refs?.tags.length ?? 0) > 0}
      <BranchSection
        label="Tags"
        count={refs?.tags.length ?? 0}
        bind:expanded={tagsExpanded}
      >
        {#each filteredTags as tag (tag.name)}
          <BranchRow name={tag.short_name} />
        {/each}
      </BranchSection>
    {/if}

    <!-- Stashes (collapsed by default; hidden if empty) -->
    {#if (refs?.stashes.length ?? 0) > 0}
      <BranchSection
        label="Stashes"
        count={refs?.stashes.length ?? 0}
        bind:expanded={stashesExpanded}
      >
        {#each filteredStashes as stash (stash.name)}
          <BranchRow name={stash.name} />
        {/each}
      </BranchSection>
    {/if}
  </div>
</aside>
