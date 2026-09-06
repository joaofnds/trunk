<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import Search from "@lucide/svelte/icons/search";
import {
	mergeBranch,
	rebaseBranch,
	resolveForkPoint,
} from "../lib/branch-op.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import {
	EVERYTHING_VISIBLE,
	type GroupState,
	groupState,
	hidesNothing,
	isRefHidden,
	isStashHidden,
	type RefVisibility,
	setGroupHidden,
	setStashGroupHidden,
	stashGroupState,
	toggleRef,
	toggleStash,
	visibilityVerb,
} from "../lib/ref-visibility.js";
import { getRefVisibility, setRefVisibility } from "../lib/store.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	GraphResponse,
	RefLabel,
	RefsResponse,
	StashEntry,
} from "../lib/types.js";
import BranchRow from "./BranchRow.svelte";
import BranchSection from "./BranchSection.svelte";
import InputDialog from "./InputDialog.svelte";
import RemoteGroup from "./RemoteGroup.svelte";
import VisibilityIcon from "./VisibilityIcon.svelte";

interface Props {
	repoPath: string;
	onrefreshed?: () => void;
	/** The graph as the backend re-laid it out after a visibility change. */
	onvisibilitychanged?: (graph: GraphResponse) => void;
	/** How many rows the graph holds, so a rebuild answers with the same depth. */
	loadedRows?: () => number;
	onstashselect?: (oid: string) => void;
	onrefnavigate?: (refNameOrOid: string) => void;
	/** Fires once the persisted hidden-ref set for this repo is known and, if it
	 *  hides anything, has been pushed to the backend -- whether that read
	 *  succeeded or failed. CommitGraph's first page load waits on it so it
	 *  never paints against the backend's unfiltered default. */
	onvisibilityresolved?: () => void;
	refreshSignal?: number;
	workingTreeDirty?: boolean;
	onopenrebaseeditor?: (baseOid: string, inclusive?: boolean) => void;
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
}

let {
	repoPath,
	onrefreshed,
	onvisibilitychanged,
	loadedRows,
	onstashselect,
	onrefnavigate,
	onvisibilityresolved,
	refreshSignal,
	workingTreeDirty,
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
let visibility = $state<RefVisibility>(EVERYTHING_VISIBLE);

/** The full ref name the hidden set is keyed by, for a row the sidebar lists by short name. */
function localRefName(branch: string): string {
	return `refs/heads/${branch}`;
}

function remoteRefName(fullName: string): string {
	return `refs/remotes/${fullName}`;
}

function tagRefName(shortName: string): string {
	return `refs/tags/${shortName}`;
}

function refLabel(
	name: string,
	ref_type: RefLabel["ref_type"],
	is_head = false,
): RefLabel {
	return { name, short_name: name, ref_type, is_head, color_index: 0 };
}

/**
 * Push the new hidden set to the backend and hand the parent the graph it returns.
 *
 * The backend rebuilds the graph from the pushed set and caches it, so every later
 * rebuild keeps the same refs hidden without the frontend resending anything. The
 * set is saved to prefs only after the graph has changed: the save is not on the
 * path between the click and the graph.
 */
async function applyVisibility(next: RefVisibility) {
	visibility = next;
	await pushVisibility(repoPath, next);
	await saveVisibility(next);
}

async function pushVisibility(path: string, next: RefVisibility) {
	const graph = await safeInvoke<GraphResponse>("set_ref_visibility", {
		path,
		visibility: next,
		loaded: loadedRows?.() ?? 0,
	});
	onvisibilitychanged?.(graph);
}

async function saveVisibility(next: RefVisibility) {
	try {
		await setRefVisibility(repoPath, next);
	} catch {
		showToast("Could not save which refs are hidden", "error");
	}
}

async function loadVisibility(path: string) {
	try {
		const stored = await getRefVisibility(path);
		visibility = stored;
		// Opening a repository walks with everything visible, so a repo with a stored set
		// needs it pushed before its first graph is drawn.
		if (!hidesNothing(stored)) await pushVisibility(path, stored);
	} catch {
		showToast("Could not load which refs are hidden", "error");
	} finally {
		// Fires on failure too: CommitGraph's first load is gated on this signal, and
		// a stuck gate would leave the graph with no first page at all.
		onvisibilityresolved?.();
	}
}

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

// The refs each group toggle covers, as `RefLabel`s the visibility functions understand.
// Built from the filtered rows rather than the full list, so a group toggle acts on exactly
// the rows the user can see it next to.
let localMembers = $derived(
	filteredLocal.map((b) =>
		refLabel(localRefName(b.name), "LocalBranch", b.is_head),
	),
);

let remoteMembers = $derived(
	Object.fromEntries(
		Object.entries(remoteGroups).map(([remote, branches]) => [
			remote,
			branches.map((b) =>
				refLabel(remoteRefName(`${remote}/${b}`), "RemoteBranch"),
			),
		]),
	),
);

let allRemoteMembers = $derived(Object.values(remoteMembers).flat());

let tagMembers = $derived(
	filteredTags.map((tg) => refLabel(tagRefName(tg.short_name), "Tag")),
);

// Load refs on mount and when repoPath changes
$effect(() => {
	const path = repoPath;
	loadRefs(path);
	loadVisibility(path);
});

// Reload refs when parent signals a refresh (e.g. context menu actions)
$effect(() => {
	if (refreshSignal !== undefined && refreshSignal > 0) {
		loadRefs(repoPath);
	}
});

// The refusal names a condition, not an event: the working tree has
// uncommitted changes. Clear it only when that condition itself has gone,
// not on every refresh — an unrelated action (e.g. creating a tag) also
// bumps refreshSignal without touching the working tree.
$effect(() => {
	if (workingTreeDirty === false) checkoutError = null;
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
  <div style="padding: var(--space-2); box-shadow: inset 0 -1px 0 var(--line);">
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
          height: 100%;
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
        groupState={groupState(visibility, localMembers)}
        ontogglevisibility={() => applyVisibility(
          setGroupHidden(visibility, localMembers, groupState(visibility, localMembers) !== 'all'),
        )}
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
              <div class="error-text" style="font-size: 11px; margin-top: var(--space-1);">{createError}</div>
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
            hidden={isRefHidden(visibility, refLabel(localRefName(branch.name), 'LocalBranch', branch.is_head))}
            ontogglevisibility={branch.is_head
              ? undefined
              : () => applyVisibility(toggleRef(visibility, refLabel(localRefName(branch.name), 'LocalBranch')))}
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
        groupState={groupState(visibility, allRemoteMembers)}
        ontogglevisibility={() => applyVisibility(
          setGroupHidden(
            visibility,
            allRemoteMembers,
            groupState(visibility, allRemoteMembers) !== 'all',
          ),
        )}
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
            groupState={groupState(visibility, remoteMembers[remoteName] ?? [])}
            hiddenBranches={Object.fromEntries(
              branches.map((b) => [
                remoteName + '/' + b,
                isRefHidden(visibility, refLabel(remoteRefName(remoteName + '/' + b), 'RemoteBranch')),
              ]),
            )}
            ontogglevisibility={() => applyVisibility(
              setGroupHidden(
                visibility,
                remoteMembers[remoteName] ?? [],
                groupState(visibility, remoteMembers[remoteName] ?? []) !== 'all',
              ),
            )}
            ontogglebranchvisibility={(fullName) =>
              applyVisibility(toggleRef(visibility, refLabel(remoteRefName(fullName), 'RemoteBranch')))}
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
        groupState={groupState(visibility, tagMembers)}
        ontogglevisibility={() => applyVisibility(
          setGroupHidden(visibility, tagMembers, groupState(visibility, tagMembers) !== 'all'),
        )}
      >
        {#each filteredTags as tag (tag.name)}
          <BranchRow
            name={tag.short_name}
            kind="tag"
            onclick={() => onrefnavigate?.(tag.short_name)}
            oncontextmenu={(e) => showTagContextMenu(e, tag.short_name)}
            hidden={isRefHidden(visibility, refLabel(tagRefName(tag.short_name), 'Tag'))}
            ontogglevisibility={() => applyVisibility(toggleRef(visibility, refLabel(tagRefName(tag.short_name), 'Tag')))}
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
      groupState={stashGroupState(visibility, filteredStashes)}
      ontogglevisibility={() => applyVisibility(
        setStashGroupHidden(
          visibility,
          filteredStashes,
          stashGroupState(visibility, filteredStashes) !== 'all',
        ),
      )}
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
          <span class="stash-message" title={stash.name}>{stash.name}</span>
          <button
            class="stash-visibility-btn"
            data-hidden={isStashHidden(visibility, stash.oid)}
            onclick={(e) => { e.stopPropagation(); applyVisibility(toggleStash(visibility, stash.oid)); }}
            aria-label="{visibilityVerb(isStashHidden(visibility, stash.oid))} {stash.short_name}"
          >
            <VisibilityIcon hidden={isStashHidden(visibility, stash.oid)} />
          </button>
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

  /*
   * Idle rows drop the eye out of the flow rather than reserving its box, so the stash
   * message gets the full width. `visibility: hidden` keeps the layout box, which is what
   * made every message truncate early against an icon that was not there.
   */
  .stash-visibility-btn {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--fg-3);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    align-items: center;
    display: none;
  }

  /* Focus reveals it too, or the control is unreachable by keyboard. A hidden stash keeps
     it permanently: the eye is the only marker saying the stash is hidden. */
  .stash-row:hover .stash-visibility-btn,
  .stash-row:focus-within .stash-visibility-btn,
  .stash-visibility-btn[data-hidden="true"] {
    display: inline-flex;
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
    padding-left: calc(var(--space-4) + var(--space-2));
  }

  .error-text {
    color: var(--color-danger);
  }
</style>
