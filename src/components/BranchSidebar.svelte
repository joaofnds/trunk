<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import Search from "@lucide/svelte/icons/search";
import { onDestroy, untrack } from "svelte";
import { deleteBranch } from "../lib/branch-delete.js";
import { mergeBranch, rebaseBranch } from "../lib/branch-op.js";
import {
	CHECKOUT_CONFLICT_MESSAGE,
	checkedOutMessage,
	isCheckoutConflict,
	reportCheckoutFailure,
} from "../lib/checkout.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { reportErrorToast } from "../lib/error-report.js";
import { filterShortcut } from "../lib/filter-shortcut.js";
import { safeInvoke, trackPending } from "../lib/invoke.js";
import { nativeMenu } from "../lib/native-menu.js";
import {
	branchRemoteMenuGroup,
	deleteRemoteBranch,
	listRemotes,
	renameBranch,
	runTagAction,
} from "../lib/ref-actions.js";
import {
	EVERYTHING_VISIBLE,
	groupState,
	hidesNothing,
	isHideable,
	isRefHidden,
	isStashHidden,
	type RefVisibility,
	setGroupHidden,
	setRefHidden,
	setStashGroupHidden,
	setStashHidden,
	stashGroupState,
	visibilityVerb,
} from "../lib/ref-visibility.js";
import { enqueueVisibility } from "../lib/ref-visibility-jobs.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { getScheduler } from "../lib/scheduler.js";
import {
	applyStash,
	dropStash,
	isStashing,
	popStash,
	saveStash,
} from "../lib/stash-actions.js";
import { getRefVisibility, setRefVisibility } from "../lib/store.js";
import {
	popupTagMenu,
	type TagAction,
	tagMenuEntriesOf,
} from "../lib/tag-menu.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	BranchInfo,
	GraphResponse,
	RebasePreviewTarget,
	RefLabel,
	RefsResponse,
	StashEntry,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import { registerUpdateBlocker } from "../lib/updates-context.js";
import BranchRow from "./BranchRow.svelte";
import BranchSection from "./BranchSection.svelte";
import InputDialog from "./InputDialog.svelte";
import RemoteGroup, { type RemoteGroupBranch } from "./RemoteGroup.svelte";
import VisibilityIcon from "./VisibilityIcon.svelte";

interface Props {
	repoPath: string;
	/** The tab's remote operation, which a remote delete from a menu runs as. */
	remoteState: RemoteState;
	onrefreshed?: () => void;
	onrefschange?: (refs: RefsResponse) => void;
	/** The graph as the backend re-laid it out after a visibility change. */
	onvisibilitychanged?: (graph: GraphResponse) => void;
	/** How many rows the graph holds, so a rebuild answers with the same depth. */
	loadedRows?: () => number;
	onrefnavigate?: (refNameOrOid: string) => void;
	/** Fires once the persisted hidden-ref set for this repo is known and, if it
	 *  hides anything, has been pushed to the backend -- whether that read
	 *  succeeded or failed. CommitGraph's first page load waits on it so it
	 *  never paints against the backend's unfiltered default. */
	onvisibilityresolved?: () => void;
	/** Whether the view's repo-changed listener has registered. The stored set's
	 *  push, not its read, waits for it, since the push answers with the view's
	 *  first graph. Defaults to true for a sidebar with no view. */
	repoListenerSettled?: boolean;
	refreshSignal?: number;
	refreshImmediately?: boolean;
	workingTreeDirty?: boolean;
	onopenrebaseeditor?: (target: RebasePreviewTarget) => void;
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
}

let {
	repoPath,
	remoteState,
	onrefreshed,
	onrefschange,
	onvisibilitychanged,
	loadedRows,
	onrefnavigate,
	onvisibilityresolved,
	repoListenerSettled = true,
	refreshSignal,
	refreshImmediately = false,
	workingTreeDirty,
	onopenrebaseeditor,
	onopenmessageeditor,
}: Props = $props();
const scheduler = getScheduler();
let sidebarActive = true;
// The push answers with the view's first graph, which must be read after the
// listener that hears the next change (TRUNK-494).
const listenerSettled = new Promise<void>((resolve) => {
	$effect(() => {
		if (repoListenerSettled) resolve();
	});
});

let refs = $state<RefsResponse | null>(null);
let loading = $state(false);
let loadSeq = 0;
let search = $state("");
let searchInput: HTMLInputElement;
const query = $derived(search.toLowerCase());
let checkingOutBranch = $state<{
	kind: "local" | "remote";
	name: string;
} | null>(null);
let checkoutError = $state<{ branch: string; message: string } | null>(null);
let localExpanded = $state(true);
let remoteExpanded = $state(false);
let tagsExpanded = $state(false);
let stashesExpanded = $state(false);
let showStashForm = $state(false);
let stashName = $state("");
let showCreateInput = $state(false);
let newBranchName = $state("");
let createInput = $state<HTMLInputElement>();
let visibility = $state.raw<RefVisibility>(EVERYTHING_VISIBLE);

/** The full ref name for a local branch the sidebar lists by short name. */
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

function visibilityBarrier() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface VisibilityView {
	path: string;
	read: ReturnType<typeof visibilityBarrier> | null;
	left: ReturnType<typeof visibilityBarrier>;
	desired: RefVisibility;
	applied: RefVisibility;
	intent: number;
}

let visibilityView: VisibilityView | null = null;

function isCurrentVisibilityView(view: VisibilityView) {
	return sidebarActive && visibilityView === view && view.path === repoPath;
}

function sameHiddenMembers(before: string[], after: string[]): boolean {
	return (
		before === after ||
		(before.length === after.length &&
			before.every((member, i) => member === after[i]))
	);
}

function sameVisibility(before: RefVisibility, after: RefVisibility): boolean {
	return (
		sameHiddenMembers(before.hiddenRefs, after.hiddenRefs) &&
		sameHiddenMembers(before.hiddenStashes, after.hiddenStashes)
	);
}

function applyVisibility(update: (current: RefVisibility) => RefVisibility) {
	const view = visibilityView;
	if (!view || !isCurrentVisibilityView(view)) return;
	const intent = ++view.intent;

	const choose = () => {
		const previous = view.desired;
		const next = update(previous);
		view.desired = next;
		if (isCurrentVisibilityView(view)) visibility = next;
		return { next, changed: !sameVisibility(previous, next) };
	};
	const choice = view.read ? view.read.promise.then(choose) : choose();

	// Register the click now, even if it needs the startup read to choose a set.
	// Closing the tab joins these jobs before replacing the backend session.
	const job = enqueueVisibility(view.path, async () => {
		const { next, changed } = await choice;
		if (sameVisibility(view.applied, next)) {
			if (changed) void trackPending(saveVisibility(view.path, next));
			return;
		}
		const loaded = isCurrentVisibilityView(view) ? (loadedRows?.() ?? 0) : 0;
		let graph: GraphResponse;
		try {
			graph = await pushVisibility(view.path, next, loaded);
		} catch (e) {
			if (intent === view.intent) {
				view.desired = view.applied;
				if (isCurrentVisibilityView(view)) {
					visibility = view.applied;
					reportErrorToast(e, "Could not change which refs are hidden");
				}
			}
			return;
		}
		view.applied = next;
		void trackPending(saveVisibility(view.path, next));
		if (isCurrentVisibilityView(view)) onvisibilitychanged?.(graph);
	});
	void trackPending(job);
}

function toggleRefVisibility(ref: RefLabel) {
	const hidden = !isRefHidden(visibility, ref);
	applyVisibility((current) => setRefHidden(current, ref, hidden));
}

function toggleGroupVisibility(members: RefLabel[]) {
	const hidden = groupState(visibility, members) !== "all";
	applyVisibility((current) => setGroupHidden(current, members, hidden));
}

function toggleStashVisibility(oid: string) {
	const hidden = !isStashHidden(visibility, oid);
	applyVisibility((current) => setStashHidden(current, oid, hidden));
}

function toggleStashGroupVisibility(stashes: StashEntry[]) {
	const hidden = stashGroupState(visibility, stashes) !== "all";
	applyVisibility((current) => setStashGroupHidden(current, stashes, hidden));
}

function pushVisibility(path: string, next: RefVisibility, loaded: number) {
	return safeInvoke<GraphResponse>("set_ref_visibility", {
		path,
		visibility: next,
		loaded,
	});
}

async function saveVisibility(path: string, next: RefVisibility) {
	try {
		await setRefVisibility(path, next);
	} catch {
		showToast("Could not save which refs are hidden", "error");
	}
}

function finishVisibilityRead(view: VisibilityView) {
	view.read?.resolve();
	view.read = null;
}

async function loadVisibility(view: VisibilityView) {
	try {
		if (!isCurrentVisibilityView(view) && view.intent === 0) return;
		const stored = await getRefVisibility(view.path);
		view.desired = stored;
		if (isCurrentVisibilityView(view)) visibility = stored;
		finishVisibilityRead(view);
		// Opening a repository walks with everything visible, so a repo with a stored set
		// needs it pushed before its first graph is drawn.
		if (!isCurrentVisibilityView(view) || hidesNothing(stored)) return;
		await Promise.race([listenerSettled, view.left.promise]);
		if (!isCurrentVisibilityView(view)) return;
		const graph = await pushVisibility(view.path, stored, loadedRows?.() ?? 0);
		view.applied = stored;
		if (isCurrentVisibilityView(view)) onvisibilitychanged?.(graph);
	} catch {
		if (isCurrentVisibilityView(view)) {
			if (view.intent === 0) {
				view.desired = view.applied;
				visibility = view.applied;
			}
			showToast("Could not load which refs are hidden", "error");
		}
	} finally {
		finishVisibilityRead(view);
		// Fires on failure too: CommitGraph's first load is gated on this signal, and
		// a stuck gate would leave the graph with no first page at all.
		if (isCurrentVisibilityView(view)) onvisibilityresolved?.();
	}
}

let filteredLocal = $derived(
	search
		? (refs?.local ?? []).filter((b) => b.name.toLowerCase().includes(query))
		: (refs?.local ?? []),
);

let filteredRemote = $derived(
	search
		? (refs?.remote ?? []).filter((b) => b.name.toLowerCase().includes(query))
		: (refs?.remote ?? []),
);

let filteredTags = $derived(
	search
		? (refs?.tags ?? []).filter((t) =>
				t.short_name.toLowerCase().includes(query),
			)
		: (refs?.tags ?? []),
);

let filteredStashes = $derived<StashEntry[]>(
	search
		? (refs?.stashes ?? []).filter(
				(s) =>
					s.name.toLowerCase().includes(query) ||
					s.short_name.toLowerCase().includes(query),
			)
		: (refs?.stashes ?? []),
);

// Use the backend's remote when it prefixes the branch name, even if it contains
// a "/". Otherwise split at the first "/", as for an aliased fetch namespace.
function remoteGroupEnd(b: BranchInfo): number {
	if (b.remote && b.name.startsWith(`${b.remote}/`)) return b.remote.length;
	return b.name.indexOf("/");
}

let remoteGroups = $derived.by(() => {
	const groups: Record<
		string,
		{ branches: RemoteGroupBranch[]; members: RefLabel[] }
	> = Object.create(null);
	for (const branch of filteredRemote) {
		const slash = remoteGroupEnd(branch);
		const prefix = slash >= 0 ? branch.name.slice(0, slash) : "";
		groups[prefix] ??= { branches: [], members: [] };
		const group = groups[prefix];
		group.branches.push({
			name: branch.name,
			shortName: branch.name.slice(slash + 1),
		});
		group.members.push(refLabel(remoteRefName(branch.name), "RemoteBranch"));
	}
	// Array-index group names sort first. The empty key keeps a real "unknown" remote separate.
	return Object.entries(groups);
});

// The refs each group toggle covers, as `RefLabel`s the visibility functions understand.
// Built from the filtered rows rather than the full list, so a group toggle acts on exactly
// the rows the user can see it next to.
let localMembers = $derived(
	filteredLocal.map((b) =>
		refLabel(localRefName(b.name), "LocalBranch", b.is_head),
	),
);

let allRemoteMembers = $derived(
	remoteGroups.flatMap(([, group]) => group.members),
);

let tagMembers = $derived(
	filteredTags.map((tg) => refLabel(tagRefName(tg.short_name), "Tag")),
);

// Load refs on mount and when repoPath changes
$effect(() => {
	void loadRefs(repoPath);
});

$effect(() => {
	const view: VisibilityView = {
		path: repoPath,
		read: visibilityBarrier(),
		left: visibilityBarrier(),
		desired: EVERYTHING_VISIBLE,
		applied: EVERYTHING_VISIBLE,
		intent: 0,
	};
	visibilityView = view;
	visibility = EVERYTHING_VISIBLE;
	enqueueVisibility(view.path, () => loadVisibility(view));
	return () => {
		visibilityView = null;
		view.left.resolve();
	};
});

// Reload refs when parent signals a refresh (e.g. context menu actions)
$effect(() => {
	if (refreshSignal !== undefined && refreshSignal > 0) {
		refsPath = repoPath;
		untrack(() => {
			if (refreshImmediately) void refsRefresh.run();
			else refsRefresh.request();
		});
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

let refsPath = "";

async function refreshRefs() {
	const path = refsPath;
	const seq = ++loadSeq;
	loading = true;
	try {
		const result = await safeInvoke<RefsResponse>("list_refs", { path });
		if (sidebarActive && seq === loadSeq && path === refsPath) {
			refs = result;
			onrefschange?.(result);
		}
	} catch {
		if (sidebarActive && seq === loadSeq && path === refsPath) {
			refs = null;
		}
	} finally {
		if (sidebarActive && seq === loadSeq && path === refsPath) {
			loading = false;
		}
	}
}

const refsRefresh = createCoalescedTask(scheduler, refreshRefs);
onDestroy(() => {
	sidebarActive = false;
	loadSeq += 1;
	refsRefresh.dispose();
});

async function loadRefs(path: string) {
	refsPath = path;
	await refsRefresh.run();
}

async function handleCheckout(branchName: string) {
	// Dismiss any existing error first
	checkoutError = null;
	checkingOutBranch = { kind: "local", name: branchName };
	try {
		await safeInvoke<void>("checkout_branch", { path: repoPath, branchName });
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(checkedOutMessage(branchName), "success");
	} catch (e) {
		if (isCheckoutConflict(e)) {
			checkoutError = {
				branch: branchName,
				message: CHECKOUT_CONFLICT_MESSAGE,
			};
		}
		reportCheckoutFailure(e);
	} finally {
		checkingOutBranch = null;
	}
}

async function handleCheckoutRemoteBranch(name: string) {
	checkoutError = null;
	checkingOutBranch = { kind: "remote", name };
	try {
		const branch = await safeInvoke<string>("checkout_remote_branch", {
			path: repoPath,
			remoteRef: remoteRefName(name),
		});
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(checkedOutMessage(branch), "success");
	} catch (e) {
		reportCheckoutFailure(e);
	} finally {
		checkingOutBranch = null;
	}
}

async function handleCreateBranch() {
	const trimmed = newBranchName.trim();
	if (!trimmed) return;

	try {
		await safeInvoke<void>("create_branch", { path: repoPath, name: trimmed });
		showCreateInput = false;
		newBranchName = "";
		await loadRefs(repoPath);
		onrefreshed?.();
		showToast(checkedOutMessage(trimmed), "success");
	} catch (e) {
		if (isCheckoutConflict(e)) {
			// Nothing was written, so the name stays in the input for a retry.
			showToast(CHECKOUT_CONFLICT_MESSAGE, "error");
		} else {
			reportErrorToast(e, "Failed to create branch");
		}
	}
}

function autoFocus(node: HTMLElement) {
	node.focus();
	return {};
}

async function handleStashSave() {
	if (!(await saveStash(repoPath, stashName.trim()))) return;

	showStashForm = false;
	stashName = "";
	await loadRefs(repoPath);
}

async function showStashEntryMenu(e: MouseEvent, stash: StashEntry) {
	e.preventDefault();
	const { Menu, MenuItem } = await nativeMenu();
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
	if (await popStash(repoPath, oid)) await loadRefs(repoPath);
}

async function handleStashApply(oid: string) {
	if (await applyStash(repoPath, oid)) await loadRefs(repoPath);
}

async function handleStashDrop(stash: StashEntry) {
	const dropped = await dropStash(repoPath, {
		oid: stash.oid,
		message: stash.name,
	});
	if (dropped) await loadRefs(repoPath);
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
	const path = repoPath;
	try {
		const outcome = await deleteBranch(path, branchName);
		if (outcome.kind === "declined") return;
		if (!sidebarActive || repoPath !== path) return;
		await loadRefs(path);
		if (!sidebarActive || repoPath !== path) return;
		onrefreshed?.();
		showToast(outcome.report, "success");
	} catch (e) {
		if (sidebarActive && repoPath === path) {
			reportErrorToast(e, "Failed to delete branch");
		}
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
			if (await renameBranch(repoPath, { from: branchName, to: values.name })) {
				await refreshAfterAction();
			}
		},
	};
}

async function refreshAfterAction() {
	await loadRefs(repoPath);
	onrefreshed?.();
}

async function handleTagAction(tagName: string, action: TagAction) {
	if (await runTagAction(repoPath, tagName, action, remoteState)) {
		await refreshAfterAction();
	}
}

async function handleDeleteRemoteBranch(fullRefName: string) {
	if (await deleteRemoteBranch(repoPath, fullRefName, remoteState)) {
		await refreshAfterAction();
	}
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

async function showBranchContextMenu(
	_e: MouseEvent,
	branchName: string,
	isHead: boolean,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
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
								onopenrebaseeditor?.({
									kind: "branch",
									refName: localRefName(branchName),
								});
							},
						}),
					]
				: []),
			await PredefinedMenuItem.new({ item: "Separator" }),
			...(await branchRemoteMenuGroup(
				repoPath,
				branchName,
				isHead,
				remoteState,
			)),
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
	const remotes = await listRemotes(repoPath);
	await popupTagMenu(
		tagMenuEntriesOf(tagShortName, remotes, remoteState.isRunning),
		(action) => {
			handleTagAction(tagShortName, action).catch(() => {});
		},
	);
}

async function showRemoteContextMenu(name: string) {
	const refName = remoteRefName(name);
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const headBranchName = refs?.local.find((b) => b.is_head)?.name;
	const menu = await Menu.new({
		items: [
			...(headBranchName
				? [
						await MenuItem.new({
							text: `Merge ${name} into ${headBranchName}`,
							action: () => {
								handleMergeBranch(refName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Rebase ${headBranchName} onto ${name}`,
							action: () => {
								handleRebaseBranch(refName).catch(() => {});
							},
						}),
						await MenuItem.new({
							text: `Interactive Rebase ${name}...`,
							action: () => {
								onopenrebaseeditor?.({ kind: "branch", refName });
							},
						}),
						await PredefinedMenuItem.new({ item: "Separator" }),
					]
				: []),
			await MenuItem.new({
				text: "Delete",
				enabled: !remoteState.isRunning,
				action: () => {
					handleDeleteRemoteBranch(name).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}
registerUpdateBlocker(() =>
	showStashForm || showCreateInput || dialogConfig !== null
		? "Finish or cancel the branch or stash form before restarting."
		: null,
);
</script>

<aside
	data-testid="branch-sidebar"
	use:filterShortcut={() => {
		searchInput.focus();
		searchInput.select();
	}}
	class="w-full min-w-0 bg-surface flex flex-col overflow-hidden"
>
	<!-- Search input (sticky at top) -->
	<div class="p-2 shadow-hairline">
		<div
			class="flex items-center gap-2 h-control-lg py-0 px-3 bg-bg border border-border rounded"
		>
			<Search size={12} color="var(--color-text-subtle)" class="shrink-0" />
			<input
				type="text"
				placeholder="Filter branches, tags, stashes…"
				aria-label="Filter branches, tags, stashes"
				bind:this={searchInput}
				onkeydown={(event) => {
					if (event.key === "Escape" && search && !event.isComposing) {
						event.preventDefault();
						event.stopPropagation();
						search = "";
					}
				}}
				bind:value={search}
				class="flex-1 min-w-0 h-full bg-transparent border-none text-text-muted text-callout"
			>
		</div>
	</div>

	<!-- Sections (scrollable) -->
	<div class="flex-1 overflow-y-auto">
		<!-- Local branches (expanded by default, show + button) -->
		{#if loading || filteredLocal.length > 0 || (refs?.local.length ?? 0) > 0}
			<BranchSection
				label="Local"
				count={filteredLocal.length}
				filterQuery={query}
				filteredFrom={search ? (refs?.local.length ?? 0) : undefined}
				expanded={localExpanded}
				ontoggle={() => (localExpanded = !localExpanded)}
				showCreateButton={true}
				oncreate={() => {
					localExpanded = true;
					showCreateInput = true;
					createInput?.focus();
				}}
				groupState={groupState(visibility, localMembers)}
				ontogglevisibility={localMembers.some(isHideable)
					? () => toggleGroupVisibility(localMembers)
					: undefined}
			>
				{#if showCreateInput}
					<div class="py-1 px-2">
						<input
							data-testid="branch-create-input"
							type="text"
							placeholder="New branch name"
							bind:value={newBranchName}
							bind:this={createInput}
							use:autoFocus
							class="w-full box-border bg-bg border border-accent create-input-ring text-text-strong text-callout py-1 px-2 h-control-lg rounded outline-none"
							onkeydown={(e) => {
								if (e.key === "Enter") handleCreateBranch();
								if (e.key === "Escape") {
									showCreateInput = false;
									newBranchName = "";
								}
							}}
						>
					</div>
				{/if}
				{#each filteredLocal as branch (branch.name)}
					<BranchRow
						name={branch.name}
						kind="local"
						isHead={branch.is_head}
						isLoading={checkingOutBranch?.kind === "local" &&
							checkingOutBranch.name === branch.name}
						isError={checkoutError?.branch === branch.name}
						errorText={checkoutError?.message}
						ahead={branch.ahead}
						behind={branch.behind}
						onclick={() => onrefnavigate?.(localRefName(branch.name))}
						ondblclick={() => handleCheckout(branch.name)}
						oncontextmenu={(e) =>
							showBranchContextMenu(e, branch.name, branch.is_head)}
						hidden={isRefHidden(
							visibility,
							refLabel(
								localRefName(branch.name),
								"LocalBranch",
								branch.is_head,
							),
						)}
						ontogglevisibility={branch.is_head
							? undefined
							: () =>
									toggleRefVisibility(
										refLabel(localRefName(branch.name), "LocalBranch"),
									)}
					/>
				{/each}
			</BranchSection>
		{/if}

		<!-- Remote branches (collapsed by default, grouped by remote) -->
		{#if (refs?.remote.length ?? 0) > 0}
			<BranchSection
				label="Remote"
				count={filteredRemote.length}
				filterQuery={query}
				filteredFrom={search ? (refs?.remote.length ?? 0) : undefined}
				expanded={remoteExpanded}
				ontoggle={() => (remoteExpanded = !remoteExpanded)}
				groupState={groupState(visibility, allRemoteMembers)}
				ontogglevisibility={() => toggleGroupVisibility(allRemoteMembers)}
			>
				{#each remoteGroups as [prefix, { branches, members }] (prefix)}
					<RemoteGroup
						remoteName={prefix || "unknown"}
						filtered={Boolean(search)}
						{branches}
						checkingOut={checkingOutBranch?.kind === "remote"
							? checkingOutBranch.name
							: null}
						oncheckout={(name) => onrefnavigate?.(remoteRefName(name))}
						ondblclick={handleCheckoutRemoteBranch}
						oncontextmenu={(_e, name) => showRemoteContextMenu(name)}
						groupState={groupState(visibility, members)}
						hiddenBranches={Object.fromEntries(
							branches.map(({ name }) => [
								name,
								isRefHidden(
									visibility,
									refLabel(remoteRefName(name), "RemoteBranch"),
								),
							]),
						)}
						ontogglevisibility={() => toggleGroupVisibility(members)}
						ontogglebranchvisibility={(name) =>
							toggleRefVisibility(
								refLabel(remoteRefName(name), "RemoteBranch"),
							)}
					/>
				{/each}
			</BranchSection>
		{/if}

		<!-- Tags (collapsed by default; hidden if empty) -->
		{#if (refs?.tags.length ?? 0) > 0}
			<BranchSection
				label="Tags"
				count={filteredTags.length}
				filterQuery={query}
				filteredFrom={search ? (refs?.tags.length ?? 0) : undefined}
				expanded={tagsExpanded}
				ontoggle={() => (tagsExpanded = !tagsExpanded)}
				groupState={groupState(visibility, tagMembers)}
				ontogglevisibility={() => toggleGroupVisibility(tagMembers)}
			>
				{#each filteredTags as tag (tag.name)}
					<BranchRow
						name={tag.short_name}
						kind="tag"
						onclick={() => onrefnavigate?.(tag.name)}
						oncontextmenu={(e) => showTagContextMenu(e, tag.short_name)}
						hidden={isRefHidden(
							visibility,
							refLabel(tagRefName(tag.short_name), "Tag"),
						)}
						ontogglevisibility={() =>
							toggleRefVisibility(refLabel(tagRefName(tag.short_name), "Tag"))}
					/>
				{/each}
			</BranchSection>
		{/if}

		<!-- Stashes — always visible so '+' button is accessible -->
		<BranchSection
			label="Stashes"
			count={filteredStashes.length}
			filterQuery={query}
			filteredFrom={search ? (refs?.stashes.length ?? 0) : undefined}
			expanded={stashesExpanded}
			ontoggle={() => (stashesExpanded = !stashesExpanded)}
			groupState={stashGroupState(visibility, filteredStashes)}
			ontogglevisibility={() => toggleStashGroupVisibility(filteredStashes)}
			showCreateButton={true}
			createLabel="Create new stash"
			oncreate={() => {
				showStashForm = !showStashForm;
				stashName = "";
				stashesExpanded = true;
			}}
		>
			<!-- Inline create form -->
			{#if showStashForm}
				<div class="stash-form">
					<input
						type="text"
						placeholder="Stash name (optional)"
						bind:value={stashName}
						onkeydown={(e) => e.key === "Enter" && handleStashSave()}
						disabled={isStashing(repoPath)}
						class="stash-name-input"
					>
					<Button
						size="sm"
						variant="primary"
						onclick={handleStashSave}
						disabled={isStashing(repoPath)}
					>
						{isStashing(repoPath) ? "Stashing…" : "Stash"}
					</Button>
				</div>
			{/if}

			<!-- Stash list entries -->
			{#each filteredStashes as stash (stash.index)}
				{@const stashHidden = isStashHidden(visibility, stash.oid)}
				<Row
					variant="flush"
					reveal={stashHidden ? "always" : "hover"}
					onclick={() => onrefnavigate?.(stash.oid)}
					oncontextmenu={(e) => showStashEntryMenu(e, stash)}
				>
					{#snippet actions()}
						<RowAction
							onclick={() => toggleStashVisibility(stash.oid)}
							oncontextmenu={(e) => showStashEntryMenu(e, stash)}
							aria-label="{visibilityVerb(stashHidden)} {stash.short_name}"
						>
							<VisibilityIcon hidden={stashHidden} />
						</RowAction>
					{/snippet}
					<Archive
						size={12}
						color="var(--color-text-subtle)"
						class="shrink-0"
					/>
					<span class="stash-index">{stash.short_name}</span>
					<span class="stash-message" title={stash.name}>{stash.name}</span>
				</Row>
			{/each}
		</BranchSection>
		{#if search &&
			refs &&
			!loading &&
			filteredLocal.length +
				filteredRemote.length +
				filteredTags.length +
				filteredStashes.length ===
				0}
			<p class="px-3 py-2 text-callout text-text-muted" role="status"
				>No matching refs or stashes</p
			>
		{/if}
	</div>

	{#if dialogConfig}
		<InputDialog
			title={dialogConfig.title}
			confirmLabel="Rename branch"
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
	font-size: var(--text-callout);
	padding: var(--space-1) var(--space-2);
	background: var(--color-bg);
	border: 1px solid var(--color-border);
	color: var(--color-text);
	border-radius: var(--radius);
}

.stash-index {
	color: var(--color-text-muted);
	font-family: var(--font-mono);
	flex-shrink: 0;
}

.stash-message {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--color-text-muted);
}

.create-input-ring {
	box-shadow: 0 0 0 3px
		color-mix(in oklch, var(--color-accent) 18%, transparent);
}
</style>
