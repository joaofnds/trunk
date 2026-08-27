<script lang="ts">
import { Archive, Search } from "@lucide/svelte";
import {
	mergeBranch,
	rebaseBranch,
	resolveForkPoint,
} from "../lib/branch-op.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { RefsResponse, StashEntry } from "../lib/types.js";
import BranchRow from "./BranchRow.svelte";
import BranchSection from "./BranchSection.svelte";
import InputDialog from "./InputDialog.svelte";
import RemoteGroup from "./RemoteGroup.svelte";

interface Props {
	repoPath: string;
	onrefreshed?: () => void;
	onstashselect?: (oid: string) => void;
	onrefnavigate?: (refNameOrOid: string) => void;
	refreshSignal?: number;
	onopenrebaseeditor?: (baseOid: string, inclusive?: boolean) => void;
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
}

let {
	repoPath,
	onrefreshed,
	onstashselect,
	onrefnavigate,
	refreshSignal,
	onopenrebaseeditor,
	onopenmessageeditor,
}: Props = $props();

let refs = $state<RefsResponse | null>(null);
let loading = $state(false);
let loadSeq = 0;
let search = $state("");
let checkingOutBranch = $state<string | null>(null);
let checkoutError = $state<{ branch: string; message: string } | null>(null);
let localExpanded = $state(true);
let remoteExpanded = $state(false);
let tagsExpanded = $state(false);
let stashesExpanded = $state(false);
let showStashForm = $state(false);
let stashName = $state("");
let stashSaving = $state(false);
let stashCreateError = $state<string | null>(null);
let stashEntryErrors = $state<Record<string, string | null>>({});
let showCreateInput = $state(false);
let newBranchName = $state("");
let createError = $state<string | null>(null);

let filteredLocal = $derived(
	search
		? (refs?.local ?? []).filter((b) =>
				b.name.toLowerCase().includes(search.toLowerCase()),
			)
		: (refs?.local ?? []),
);

let filteredRemote = $derived(
	search
		? (refs?.remote ?? []).filter((b) =>
				b.name.toLowerCase().includes(search.toLowerCase()),
			)
		: (refs?.remote ?? []),
);

let filteredTags = $derived(
	search
		? (refs?.tags ?? []).filter((t) =>
				t.short_name.toLowerCase().includes(search.toLowerCase()),
			)
		: (refs?.tags ?? []),
);

let filteredStashes = $derived<StashEntry[]>(
	search
		? (refs?.stashes ?? []).filter((s) =>
				s.name.toLowerCase().includes(search.toLowerCase()),
			)
		: (refs?.stashes ?? []),
);

// Group remote branches by remote name: { "origin": ["main", "dev"] }
let remoteGroups = $derived(
	filteredRemote.reduce<Record<string, string[]>>((acc, b) => {
		const slash = b.name.indexOf("/");
		const remote = slash >= 0 ? b.name.slice(0, slash) : "unknown";
		const short = slash >= 0 ? b.name.slice(slash + 1) : b.name;
		if (!acc[remote]) acc[remote] = [];
		acc[remote].push(short);
		return acc;
	}, {}),
);

// Load refs on mount and when repoPath changes
$effect(() => {
	const path = repoPath;
	loadRefs(path);
});

// Reload refs when parent signals a refresh (e.g. context menu actions)
$effect(() => {
	if (refreshSignal !== undefined && refreshSignal > 0) {
		loadRefs(repoPath);
	}
});

// Dismiss error when search changes
$effect(() => {
	if (search) checkoutError = null;
});

async function loadRefs(path: string) {
	const seq = ++loadSeq;
	loading = true;
	try {
		const result = await safeInvoke<RefsResponse>("list_refs", { path });
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
		await safeInvoke<void>("checkout_branch", { path: repoPath, branchName });
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(`Checked out ${branchName}`, "success");
	} catch (e) {
		if (isTrunkError(e) && e.code === "dirty_workdir") {
			checkoutError = {
				branch: branchName,
				message:
					"Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.",
			};
		}
		showToast("Checkout failed", "error");
	} finally {
		checkingOutBranch = null;
	}
}

async function handleCheckoutRemoteBranch(fullName: string) {
	const shortName = fullName.slice(fullName.indexOf("/") + 1);
	checkoutError = null;
	checkingOutBranch = fullName;
	try {
		await safeInvoke<void>("create_branch", {
			path: repoPath,
			name: shortName,
			fromOid: fullName,
		});
		await loadRefs(repoPath);
		onrefreshed?.();
	} catch (e) {
		reportErrorToast(e, "Checkout failed");
	} finally {
		checkingOutBranch = null;
	}
}

async function handleCreateBranch() {
	const trimmed = newBranchName.trim();
	if (!trimmed) return;
	createError = null;
	try {
		await safeInvoke<void>("create_branch", { path: repoPath, name: trimmed });
		showCreateInput = false;
		newBranchName = "";
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(`Checked out ${trimmed}`, "success");
	} catch (e) {
		if (isTrunkError(e) && e.code === "dirty_workdir") {
			showToast(
				"Branch created (checkout skipped — uncommitted changes)",
				"success",
			);
			showCreateInput = false;
			newBranchName = "";
			await loadRefs(repoPath);
			onrefreshed?.();
		} else {
			createError = errorMessage(e, "Failed to create branch");
		}
	}
}

function autoFocus(node: HTMLElement) {
	node.focus();
	return {};
}

async function handleStashSave() {
	stashSaving = true;
	stashCreateError = null;
	try {
		await safeInvoke("stash_save", {
			path: repoPath,
			message: stashName.trim(),
		});
		showStashForm = false;
		stashName = "";
		await loadRefs(repoPath);
	} catch (e) {
		if (isTrunkError(e) && e.code === "nothing_to_stash") {
			stashCreateError = "Nothing to stash — working tree is clean";
		} else {
			stashCreateError = errorMessage(e, "Failed to create stash");
		}
	} finally {
		stashSaving = false;
	}
}

async function showStashEntryMenu(e: MouseEvent, stash: StashEntry) {
	e.preventDefault();
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Pop",
				action: () => {
					handleStashPop(stash.oid).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Apply",
				action: () => {
					handleStashApply(stash.oid).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Drop",
				action: () => {
					handleStashDrop(stash).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function handleStashPop(oid: string) {
	stashEntryErrors = { ...stashEntryErrors, [oid]: null };
	try {
		await safeInvoke("stash_pop", { path: repoPath, oid });
		await loadRefs(repoPath);
	} catch (e) {
		stashEntryErrors = {
			...stashEntryErrors,
			[oid]: errorMessage(e, "Failed to pop stash"),
		};
	}
}

async function handleStashApply(oid: string) {
	stashEntryErrors = { ...stashEntryErrors, [oid]: null };
	try {
		await safeInvoke("stash_apply", { path: repoPath, oid });
		await loadRefs(repoPath);
	} catch (e) {
		stashEntryErrors = {
			...stashEntryErrors,
			[oid]: errorMessage(e, "Failed to apply stash"),
		};
	}
}

async function handleStashDrop(stash: StashEntry) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Drop ${stash.short_name} (${stash.name})? This cannot be undone.`,
		{ title: "Confirm Drop", kind: "warning" },
	);
	if (!confirmed) return;
	stashEntryErrors = { ...stashEntryErrors, [stash.oid]: null };
	try {
		await safeInvoke("stash_drop", { path: repoPath, oid: stash.oid });
		await loadRefs(repoPath);
	} catch (e) {
		stashEntryErrors = {
			...stashEntryErrors,
			[stash.oid]: errorMessage(e, "Failed to drop stash"),
		};
	}
}

// --- Branch/Tag context menu support ---

interface DialogConfig {
	title: string;
	fields: {
		key: string;
		label: string;
		placeholder?: string;
		required?: boolean;
		defaultValue?: string;
	}[];
	onsubmit: (values: Record<string, string>) => void;
}
let dialogConfig = $state<DialogConfig | null>(null);
function closeDialog() {
	dialogConfig = null;
}

async function handleDeleteBranch(branchName: string) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Delete branch '${branchName}'? This cannot be undone.`,
		{
			title: "Delete Branch",
			kind: "warning",
		},
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_branch", { path: repoPath, branchName });
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(`Deleted branch ${branchName}`, "success");
	} catch (e) {
		reportErrorToast(e, "Failed to delete branch");
	}
}

function handleRenameBranch(branchName: string) {
	dialogConfig = {
		title: "Rename Branch",
		fields: [
			{
				key: "name",
				label: "New name",
				required: true,
				defaultValue: branchName,
			},
		],
		onsubmit: async (values) => {
			closeDialog();
			const newName = values.name.trim();
			if (!newName || newName === branchName) return;
			try {
				await safeInvoke("rename_branch", {
					path: repoPath,
					oldName: branchName,
					newName,
				});
				await loadRefs(repoPath);
				onrefreshed?.();
				showToast(`Renamed branch to ${newName}`, "success");
			} catch (e) {
				reportErrorToast(e, "Failed to rename branch");
			}
		},
	};
}

async function handleDeleteTag(tagName: string) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Delete tag '${tagName}'? This cannot be undone.`,
		{
			title: "Delete Tag",
			kind: "warning",
		},
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_tag", { path: repoPath, tagName });
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(`Deleted tag ${tagName}`, "success");
	} catch (e) {
		reportErrorToast(e, "Failed to delete tag");
	}
}

async function refreshAfterAction() {
	await loadRefs(repoPath);
	onrefreshed?.();
}

function handleMergeBranch(branch: string) {
	return mergeBranch({
		repoPath,
		branch,
		openMessageEditor: onopenmessageeditor,
		onDone: refreshAfterAction,
	});
}

function handleRebaseBranch(ontoBranch: string) {
	return rebaseBranch({ repoPath, ontoBranch, onDone: refreshAfterAction });
}

async function handleInteractiveRebase(branchName: string) {
	const forkPoint = await resolveForkPoint({ repoPath, branch: branchName });
	if (forkPoint !== null) onopenrebaseeditor?.(forkPoint);
}

async function handleDeleteRemoteBranch(fullRefName: string) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Delete remote branch '${fullRefName}'? This will remove it from the remote.`,
		{ title: "Delete Remote Branch", kind: "warning" },
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_remote_branch", {
			path: repoPath,
			branchName: fullRefName,
		});
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(`Deleted remote branch ${fullRefName}`, "success");
	} catch (e) {
		reportErrorToast(e, "Failed to delete remote branch");
	}
}

async function showBranchContextMenu(
	_e: MouseEvent,
	branchName: string,
	isHead: boolean,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const headBranchName = refs?.local.find((b) => b.is_head)?.name;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Checkout",
				enabled: !isHead,
				action: () => {
					handleCheckout(branchName);
				},
			}),
			...(!isHead && headBranchName
				? [
						await MenuItem.new({
							text: `Merge ${branchName} into ${headBranchName}`,
							action: () => {
								handleMergeBranch(branchName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Rebase ${headBranchName} onto ${branchName}`,
							action: () => {
								handleRebaseBranch(branchName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Interactive Rebase ${branchName}...`,
							action: () => {
								handleInteractiveRebase(branchName).catch(() => {});
							},
						}),
					]
				: []),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Rename…",
				action: () => {
					handleRenameBranch(branchName);
				},
			}),
			await MenuItem.new({
				text: "Delete",
				enabled: !isHead,
				action: () => {
					handleDeleteBranch(branchName).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function showTagContextMenu(_e: MouseEvent, tagShortName: string) {
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Delete",
				action: () => {
					handleDeleteTag(tagShortName).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function showRemoteContextMenu(_e: MouseEvent, fullRefName: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const headBranchName = refs?.local.find((b) => b.is_head)?.name;
	const menu = await Menu.new({
		items: [
			...(headBranchName
				? [
						await MenuItem.new({
							text: `Merge ${fullRefName} into ${headBranchName}`,
							action: () => {
								handleMergeBranch(fullRefName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Rebase ${headBranchName} onto ${fullRefName}`,
							action: () => {
								handleRebaseBranch(fullRefName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Interactive Rebase ${fullRefName}...`,
							action: () => {
								handleInteractiveRebase(fullRefName).catch(() => {});
							},
						}),
						await PredefinedMenuItem.new({ item: "Separator" }),
					]
				: []),
			await MenuItem.new({
				text: "Delete",
				action: () => {
					handleDeleteRemoteBranch(fullRefName).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}
</script>

<aside data-testid="branch-sidebar" style="
  width: 100%;
  min-width: 0;
  background: var(--bg-1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
">
  <!-- Search input (sticky at top) -->
  <div style="padding: var(--space-3) var(--space-3) var(--space-2); border-bottom: 1px solid var(--line);">
    <div style="
      display: flex;
      align-items: center;
      gap: var(--space-2);
      height: var(--control-lg-h);
      padding: 0 var(--space-3);
      background: var(--bg-0);
      border: 1px solid var(--line);
      border-radius: var(--radius);
    ">
      <Search size={12} color="var(--fg-3)" style="flex-shrink: 0;" />
      <input
        type="text"
        placeholder="Filter branches…"
        bind:value={search}
        style="
          flex: 1;
          min-width: 0;
          background: transparent;
          border: none;
          color: var(--fg-2);
          font-size: 12px;
          outline: none;
        "
      />
    </div>
  </div>

  <!-- Sections (scrollable) -->
  <div style="flex: 1; overflow-y: auto;">
    <!-- Local branches (expanded by default, show + button) -->
    {#if loading || filteredLocal.length > 0 || (refs?.local.length ?? 0) > 0}
      <BranchSection
        label="Local"
        count={refs?.local.length ?? 0}
        expanded={localExpanded}
        ontoggle={() => (localExpanded = !localExpanded)}
        showCreateButton={true}
        oncreate={() => { showCreateInput = true; }}
      >
        {#if showCreateInput}
          <div style="padding: var(--space-1) var(--space-2) var(--space-1);">
            <input
              data-testid="branch-create-input"
              type="text"
              placeholder="New branch name"
              bind:value={newBranchName}
              use:autoFocus
              style="
                width: 100%;
                box-sizing: border-box;
                background: var(--bg-0);
                border: 1px solid var(--accent);
                box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
                color: var(--fg-0);
                font-size: 12px;
                padding: var(--space-1) var(--space-2);
                height: var(--control-lg-h);
                border-radius: var(--radius);
                outline: none;
              "
              onkeydown={(e) => {
                if (e.key === 'Enter') handleCreateBranch();
                if (e.key === 'Escape') { showCreateInput = false; newBranchName = ''; createError = null; }
              }}
            />
            {#if createError}
              <div class="error-text" style="font-size: 11px; margin-top: 2px;">{createError}</div>
            {/if}
          </div>
        {/if}
        {#each filteredLocal as branch (branch.name)}
          <BranchRow
            name={branch.name}
            kind="local"
            isHead={branch.is_head}
            isLoading={checkingOutBranch === branch.name}
            isError={checkoutError?.branch === branch.name}
            errorText={checkoutError?.message}
            ahead={branch.ahead}
            behind={branch.behind}
            onclick={() => onrefnavigate?.(branch.name)}
            ondblclick={() => handleCheckout(branch.name)}
            oncontextmenu={(e) => showBranchContextMenu(e, branch.name, branch.is_head)}
          />
        {/each}
      </BranchSection>
    {/if}

    <!-- Remote branches (collapsed by default, grouped by remote) -->
    {#if (refs?.remote.length ?? 0) > 0}
      <BranchSection
        label="Remote"
        count={refs?.remote.length ?? 0}
        expanded={remoteExpanded}
        ontoggle={() => (remoteExpanded = !remoteExpanded)}
      >
        {#each Object.entries(remoteGroups) as [remoteName, branches] (remoteName)}
          <RemoteGroup
            {remoteName}
            {branches}
            checkingOut={checkingOutBranch}
            errorBranch={checkoutError?.branch ?? null}
            errorText={checkoutError?.message ?? ''}
            oncheckout={(fullName) => onrefnavigate?.(fullName)}
            ondblclick={handleCheckoutRemoteBranch}
            oncontextmenu={(e, fullName) => showRemoteContextMenu(e, fullName)}
          />
        {/each}
      </BranchSection>
    {/if}

    <!-- Tags (collapsed by default; hidden if empty) -->
    {#if (refs?.tags.length ?? 0) > 0}
      <BranchSection
        label="Tags"
        count={refs?.tags.length ?? 0}
        expanded={tagsExpanded}
        ontoggle={() => (tagsExpanded = !tagsExpanded)}
      >
        {#each filteredTags as tag (tag.name)}
          <BranchRow
            name={tag.short_name}
            kind="tag"
            onclick={() => onrefnavigate?.(tag.short_name)}
            oncontextmenu={(e) => showTagContextMenu(e, tag.short_name)}
          />
        {/each}
      </BranchSection>
    {/if}

    <!-- Stashes — always visible so '+' button is accessible -->
    <BranchSection
      label="Stashes"
      count={filteredStashes.length}
      expanded={stashesExpanded}
      ontoggle={() => (stashesExpanded = !stashesExpanded)}
      showCreateButton={true}
      oncreate={() => { showStashForm = !showStashForm; stashCreateError = null; stashName = ''; stashesExpanded = true; }}
    >
      <!-- Inline create form -->
      {#if showStashForm}
        <div class="stash-form">
          <input
            type="text"
            placeholder="Stash name (optional)"
            bind:value={stashName}
            onkeydown={(e) => e.key === 'Enter' && handleStashSave()}
            disabled={stashSaving}
            class="stash-name-input"
          />
          <button
            onclick={handleStashSave}
            disabled={stashSaving}
            class="stash-save-btn"
          >{stashSaving ? 'Stashing…' : 'Stash'}</button>
        </div>
        {#if stashCreateError}
          <p class="stash-error">{stashCreateError}</p>
        {/if}
      {/if}

      <!-- Stash list entries -->
      {#each filteredStashes as stash (stash.index)}
        <div
          class="stash-row"
          role="button"
          tabindex="0"
          onclick={() => onrefnavigate?.(stash.oid)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onrefnavigate?.(stash.oid); } }}
          oncontextmenu={(e) => showStashEntryMenu(e, stash)}
        >
          <Archive size={12} color="var(--fg-3)" style="flex-shrink: 0;" />
          <span class="stash-index">{stash.short_name}</span>
          <span class="stash-message">{stash.name}</span>
        </div>
        {#if stashEntryErrors[stash.oid]}
          <p class="stash-error stash-entry-error">{stashEntryErrors[stash.oid]}</p>
        {/if}
      {/each}
    </BranchSection>
  </div>

  {#if dialogConfig}
    <InputDialog
      title={dialogConfig.title}
      fields={dialogConfig.fields}
      onsubmit={dialogConfig.onsubmit}
      oncancel={closeDialog}
    />
  {/if}
</aside>

<style>
  .stash-form {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
  }

  .stash-name-input {
    flex: 1;
    font-size: 12px;
    padding: var(--space-1) var(--space-2);
    background: var(--bg-0);
    border: 1px solid var(--line);
    color: var(--fg-1);
    border-radius: var(--radius);
  }

  .stash-save-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    cursor: pointer;
    background: var(--accent);
    color: var(--accent-fg);
    border: none;
    border-radius: var(--radius);
  }

  .stash-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    font-size: 12px;
    cursor: default;
  }

  .stash-row:hover {
    background: var(--bg-hover);
  }

  .stash-index {
    color: var(--fg-2);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .stash-message {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-2);
  }

  .stash-error {
    font-size: 11px;
    color: var(--err);
    padding: var(--space-1) var(--space-3) var(--space-1);
    margin: 0;
  }

  .stash-entry-error {
    padding-left: 24px;
  }

  .error-text {
    color: var(--color-danger);
  }
</style>
