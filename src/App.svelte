<script lang="ts">
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onDestroy, onMount, tick, untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import RecentReposPicker from "./components/RecentReposPicker.svelte";
import RepoView from "./components/RepoView.svelte";
import TabBar from "./components/TabBar.svelte";
import Toast from "./components/Toast.svelte";
import Toolbar from "./components/Toolbar.svelte";
import UpdateControl from "./components/UpdateControl.svelte";
import UpdatePanel from "./components/UpdatePanel.svelte";
import WelcomeScreen from "./components/WelcomeScreen.svelte";
import { AutofetchScheduler } from "./lib/autofetch.js";
import type { FetchReport } from "./lib/autofetch-status.js";
import { copyText } from "./lib/clipboard.js";
import {
	type CoalescedTask,
	createCoalescedTask,
} from "./lib/coalesced-task.js";
import { open } from "./lib/dialog.js";
import { DiffPreferences } from "./lib/diff-preferences.svelte.js";
import { errorMessage } from "./lib/error-report.js";
import { provideFileLabelStyle } from "./lib/file-label-style.svelte.js";
import { invokesSettled, safeInvoke, trackPending } from "./lib/invoke.js";
import { focusInEditable, keyChord, onMac } from "./lib/keyboard.js";
import { nativeMenu } from "./lib/native-menu.js";
import { createOwnedTimer } from "./lib/owned-timer.js";
import { repositoryName } from "./lib/path.js";
import { perfEnabled, record } from "./lib/perf.js";
import { visibilityJobsSettled } from "./lib/ref-visibility-jobs.js";
import {
	createRemoteState,
	type RemoteState,
} from "./lib/remote-state.svelte.js";
import {
	type RepoChanged,
	requestRepoChange,
} from "./lib/repo-change-subscription.js";
import {
	RepositoryTabs,
	repositoryPathKey,
} from "./lib/repository-tabs.svelte.js";
import { repositoryToOpen } from "./lib/repository-to-open.js";
import { ALL_THREADS } from "./lib/review-filter.js";
import { getScheduler } from "./lib/scheduler.js";
import {
	addRecentRepo,
	copyLegacyUserWidthsOnce,
	DEFAULT_LEFT_PANE_WIDTH,
	DEFAULT_RIGHT_PANE_WIDTH,
	flushPreferencesForUpdate,
	getDiffContentMode,
	getFetchIntervalMs,
	getLeftPaneCollapsed,
	getLeftPaneWidth,
	getOpenRepo,
	getReviewLeftPaneCollapsed,
	getReviewThreadsHidden,
	getRightPaneCollapsed,
	getRightPaneWidth,
	getZoomLevel,
	openTabSession,
	preferenceGeneration,
	type RecentRepo,
	refVisibilityWritesSettled,
	setDiffContentMode,
	setLeftPaneCollapsed,
	setOpenRepo,
	setReviewLeftPaneCollapsed,
	setReviewThreadsHidden,
	setRightPaneCollapsed,
	setZoomLevel,
	subscribeFetchInterval,
	type TabSession,
	type TabSnapshot,
} from "./lib/store.js";
import { canMoveTab, moveTab } from "./lib/tab-order.js";
import type { TabInfo } from "./lib/tab-types.js";
import { createTabId } from "./lib/tab-types.js";
import { installTextSelection } from "./lib/text-selection.js";
import { showToast } from "./lib/toast.svelte.js";
import type { ContentMode, ReviewTone, ThreadFilter } from "./lib/types.js";
import Button from "./lib/ui/Button.svelte";
import { releaseUrl, type UpdateStatus, updates } from "./lib/updates.js";
import { provideUpdatePreparation } from "./lib/updates-context.js";
import { setUpdateFrozen, UpdatePreparation } from "./lib/updates-lifecycle.js";
import { UpdateCheckScheduler } from "./lib/updates-scheduler.js";

provideFileLabelStyle();
onMount(() => installTextSelection(document));

let updateStatus = $state<UpdateStatus | null>(null);
let updateOpen = $state(false);
let updateBusy = $state(false);
let updateFrozen = $state(false);
let restartWaiting = $state(false);
let confirmUpdateVersion = $state<string | null>(null);
let updateError = $state<string | null>(null);
let updateRetry = $state<"status" | "readiness" | null>(null);
let tabsRestored = $state(false);
let updateReadinessSent = false;
const recoveredRepositories = new SvelteMap<
	string,
	{ path: string; error: string | null }
>();
function acceptUpdateStatus(status: UpdateStatus | null | undefined): void {
	if (!status) return;

	updateStatus = status;

	if (
		confirmUpdateVersion &&
		(status.phase !== "ready" || status.version !== confirmUpdateVersion)
	)
		confirmUpdateVersion = null;

	if (status.phase === "recovery") {
		updateOpen = true;
	}
}

const updateClock = getScheduler();
const updateChecks = new UpdateCheckScheduler(
	createOwnedTimer({ background: true }),
	() => updateClock.currentTimeMs(),
	Math.random,
	() => updateAction(updates.check, true),
);
onDestroy(() => updateChecks.update(false, false));
const releaseChecksEnabled = $derived(updateStatus !== null);
const preparation = new UpdatePreparation({
	prepare: updates.prepare,
	drained: updates.drained,
	install: updates.install,
	abort: async (token) => {
		try {
			updateStatus = await updates.abort(token);
		} catch (error) {
			const status = await updates.status();
			updateStatus = status;
			if (!["ready", "idle", "manual", "available"].includes(status.phase))
				throw error;
		}
	},
	freeze: (frozen) => {
		updateFrozen = frozen;
		if (frozen) updateOpen = true;
		setUpdateFrozen(frozen);
		updateChecks.update(releaseChecksEnabled, frozen || updateBusy);
		if (!frozen)
			void updates.resume().catch(() => {
				updateError =
					"Could not refresh repositories after preparing the update. Refresh before continuing.";
			});
	},
	settle: () => invokesSettled(updateClock),
	waiting: (waiting) => {
		restartWaiting = waiting;
	},
});
provideUpdatePreparation(preparation);
onDestroy(() => setUpdateFrozen(false));

async function updateAction(
	action: () => Promise<UpdateStatus | undefined>,
	automatic = false,
): Promise<void> {
	if (updateBusy) return;
	if (!automatic) updateChecks.reset();
	updateBusy = true;
	updateError = null;
	try {
		const status = await action();

		if (status) acceptUpdateStatus(status);
		if (!automatic && status?.message) updateOpen = true;
	} catch (error) {
		updateError = errorMessage(
			error,
			"The update could not complete. Try again.",
		);
		if (automatic) throw error;
		updateOpen = true;
	} finally {
		updateBusy = false;
	}
}

async function retryStartupUpdate(): Promise<void> {
	const retry = updateRetry;
	if (!retry) return;

	await updateAction(async () => {
		const status =
			retry === "readiness" ? await updates.ready() : await updates.status();
		updateRetry = null;
		return status;
	});
}

function downloadUpdate(version: string): void {
	void updateAction(async () => {
		if (updateStatus?.eligible && updateStatus.adopted)
			return updates.download(version);

		await openUrl(releaseUrl(version));

		return undefined;
	});
}

$effect(() => {
	let disposed = false;
	const removals: (() => void)[] = [];
	const own = (remove: () => void) => {
		if (disposed) remove();
		else removals.push(remove);
	};
	void listen<UpdateStatus>("updates-changed", ({ payload }) => {
		if (!disposed) acceptUpdateStatus(payload);
	}).then(own);
	void listen<void>("updates-open", () => {
		if (!disposed) {
			updateOpen = true;
			void updateAction(async () => {
				const status = await updates.status();
				return ["manual", "idle", "available", "ready"].includes(status.phase)
					? updates.check()
					: status;
			});
		}
	}).then(own);
	void updates
		.status()
		.then((status) => {
			if (!disposed) acceptUpdateStatus(status);
		})
		.catch((error) => {
			if (disposed) return;
			updateError = errorMessage(error, "Could not read update status.");
			updateRetry = "status";
			updateOpen = true;
		});
	return () => {
		disposed = true;
		for (const remove of removals) remove();
	};
});

$effect(() => {
	updateChecks.update(
		releaseChecksEnabled,
		updateFrozen ||
			updateBusy ||
			["downloading", "ready", "preparing", "installing", "recovery"].includes(
				updateStatus?.phase ?? "",
			),
	);
});

$effect(() => {
	if (
		updateReadinessSent ||
		!updateStatus ||
		!tabsRestored ||
		!diffSettingsLoaded
	)
		return;
	for (const tab of tabs) {
		if (!tab.repoPath) continue;
		const recovery = recoveredRepositories.get(tab.id);
		if (recovery?.path === tab.repoPath && recovery.error) return;
		if (
			(tab.id === activeTabId || isRepoViewMounted(tab)) &&
			recovery?.path !== tab.repoPath
		)
			return;
	}
	updateReadinessSent = true;
	untrack(() => {
		void updates
			.ready()
			.then((status) => {
				if (status) acceptUpdateStatus(status);
			})
			.catch((error) => {
				updateError = errorMessage(
					error,
					"Could not verify startup after the update.",
				);
				updateRetry = "readiness";
				updateOpen = true;
			});
	});
});

$effect(() => {
	function preventFrozenInput(event: Event) {
		if (
			!updateFrozen ||
			(event.target instanceof Element &&
				event.target.closest("[data-update-panel]"))
		)
			return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}
	const events = ["keydown", "beforeinput", "input", "click", "pointerdown"];
	for (const event of events)
		window.addEventListener(event, preventFrozenInput, true);
	return () => {
		for (const event of events)
			window.removeEventListener(event, preventFrozenInput, true);
	};
});

// Global layout state (D-01, D-02, D-03)
let zoomLevel = $state(1);
let leftPaneWidth = $state(DEFAULT_LEFT_PANE_WIDTH);
let leftPaneCollapsed = $state(false);
let rightPaneWidth = $state(DEFAULT_RIGHT_PANE_WIDTH);
let rightPaneCollapsed = $state(false);
let reviewLeftPaneCollapsed = $state(false);
let isFullscreen = $state(false);
let windowFocused = $state(false);

interface RepositoryPicker {
	readonly tabId: string;
}

let picker = $state.raw<RepositoryPicker | null>(null);

// Review panel toggle (Phase 65, D-12 throwaway stub) — flipped by the View-menu
// "Start/End Code Review" item via the review-toggle event.
let reviewPanelOpen = $state(false);
// Whether the active review tab's center pane is showing the review panel (vs. a
// diff), reported up by RepoView. Drives the Toolbar Review button: lit only while
// the panel is up, and a click while on a diff returns to the panel instead of
// ending review (260531-l02e). Defaults true (panel shows on review entry).
let activeReviewPanelShowing = $state(true);

// Review presentation: App owns the thread filter, which the review panel
// narrows, and whether the toolbar hides review threads from the graph and the
// diff. Only the hiding is persisted. RepoView reports per-tab filtered badge
// counts up. The active tab alone feeds the toolbar.
let threadFilter = $state<ThreadFilter>(ALL_THREADS);
let reviewThreadsHidden = $state(false);
let reviewThreadsHiddenChanged = false;
let diffContentMode = $state<ContentMode>("hunk");
let diffContentModeChanged = false;
let diffContentModeLoaded = $state(false);
// A repository's diffs are read and drawn under these settings, so no tab
// mounts before they are known: a diff drawn under the defaults picks the
// wrong view for a frame, and inline hunks over a full-file payload build every
// line of a large file at once.
let diffPreferences = $state.raw<DiffPreferences | null>(null);
const diffSettingsLoaded = $derived(
	diffContentModeLoaded && diffPreferences !== null,
);
let commentCounts = $state<
	Map<
		string,
		{
			view: number;
			total: number;
			viewTone: ReviewTone | null;
			totalTone: ReviewTone | null;
		}
	>
>(new Map());

function setCommentCounts(
	tabId: string,
	counts: {
		view: number;
		total: number;
		viewTone: ReviewTone | null;
		totalTone: ReviewTone | null;
	},
) {
	const next = new Map(commentCounts);
	next.set(tabId, counts);
	commentCounts = next;
}

async function handleReviewThreadsHiddenChange(hidden: boolean) {
	reviewThreadsHiddenChanged = true;
	reviewThreadsHidden = hidden;
	try {
		await setReviewThreadsHidden(hidden);
	} catch {
		showToast("Could not save hidden review threads", "error");
	}
}

async function handleDiffContentModeChange(mode: ContentMode) {
	diffContentModeChanged = true;
	diffContentMode = mode;
	try {
		await setDiffContentMode(mode);
	} catch {
		showToast("Could not save diff content mode", "error");
	}
}

// Tab state
let tabs = $state<TabInfo[]>([]);
// The repository views stack in one place, so their page order shows nothing.
// Keeping it fixed when the strip reorders spares each view the move that would
// drop its scroll offsets and the focus inside it.
const tabViews = $derived(
	[...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
);
let activeTabId = $state<string>("");
let initialActiveId: string | null = null;
const scheduler = getScheduler();
const autofetch = new AutofetchScheduler(scheduler, runAutofetch);
let repositoryTabsDisposed = false;
const dirtyCountRefreshes = new Map<string, CoalescedTask>();
const closingRepositories = new Map<string, Promise<void>>();
interface PendingOpen {
	readonly name: string;
	readonly fromPicker?: RepositoryPicker;
	// The tab can still recover if this choice replaces the failed repository.
	restoreFailure?: { path: string; error: unknown };
	cancel(): void;
}
const pendingOpens = new SvelteMap<string, PendingOpen>();
let recentRepositoryWrites = Promise.resolve();
const repositories = new RepositoryTabs(scheduler, {
	open: openRepositoryBackend,
	close: closeUnusedRepository,
	loadUnvisitedBadge: async ({ id, repoPath: path }) => {
		try {
			const counts = await safeInvoke<{ staged: number; unstaged: number }>(
				"get_dirty_counts",
				{ path },
			);
			const tab = tabs.find((tab) => tab.id === id && tab.repoPath === path);
			if (tab && !isRepoViewMounted(tab)) updateDirtyBadge(tab, counts);
		} catch {
			// Keep the previous marker if the initial status read fails.
		}
	},
	failed: ({ id, repoPath }, error) => {
		const request = pendingOpens.get(id);
		if (request) request.restoreFailure = { path: repoPath, error };
		else closeFailedRestore(id, repoPath, error);
	},
});

$effect(() => {
	const currentTabs = tabs.map(({ id, repoPath }) => ({
		id,
		repoPath,
	}));
	const active = activeTabId;
	if (initialActiveId !== active) initialActiveId = null;
	untrack(() => {
		for (const [id, request] of pendingOpens) {
			if (currentTabs.some((tab) => tab.id === id)) continue;
			request.cancel();
			pendingOpens.delete(id);
		}
		const currentPicker = picker;
		if (
			currentPicker &&
			!currentTabs.some((tab) => tab.id === currentPicker.tabId)
		)
			closePicker(currentPicker);
		repositories.update(currentTabs, active);
	});
});

async function runAutofetch(path: string, intervalMs: number): Promise<void> {
	if (updateFrozen || restartWaiting) return;
	const tab = tabs.find((tab) => tab.repoPath === path);
	const target = tab ? tabStates.get(tab.id)?.remoteState : undefined;
	let report: FetchReport;
	try {
		report = await safeInvoke<FetchReport>("git_fetch_background", {
			path,
			intervalMs,
		});
	} catch {
		report = {
			outcome: "failed",
			remotes: target?.autofetch?.remotes ?? [],
			graph_error: null,
			graph_rebuilds: 0,
			job_error: "Automatic fetch could not start; try Fetch.",
		};
	}
	if (perfEnabled())
		record("autofetch:outcome", 0, {
			outcome: report.outcome,
			graph_rebuilds: report.graph_rebuilds,
			remotes: report.remotes.length,
		});
	if (target && tab && tabStates.get(tab.id)?.remoteState === target)
		target.autofetch = report;
}

$effect(() => {
	let disposed = false;
	let preferenceChanged = false;
	const unsubscribe = subscribeFetchInterval((ms) => {
		preferenceChanged = true;
		autofetch.setInterval(ms);
	});
	void getFetchIntervalMs().then((ms) => {
		if (!disposed && !preferenceChanged) {
			autofetch.setInterval(ms);
		}
	});
	return () => {
		disposed = true;
		unsubscribe();
		autofetch.dispose();
	};
});

$effect(() => {
	const paths = tabs.flatMap((tab) =>
		tab.repoPath && repositories.isReady(tab) ? [tab.repoPath] : [],
	);
	const activePath =
		tabs.find((tab) => tab.id === activeTabId)?.repoPath ?? null;
	const manualBusy = [...tabStates.values()].some(
		(state) => state.remoteState.isRunning,
	);
	const focused = windowFocused && !updateFrozen;
	untrack(() => autofetch.update({ paths, activePath, focused, manualBusy }));
});

const activeInlineCommentCount = $derived(
	commentCounts.get(activeTabId)?.view ?? 0,
);

const activeReviewCommentCount = $derived(
	commentCounts.get(activeTabId)?.total ?? 0,
);
const activeInlineCommentTone = $derived(
	commentCounts.get(activeTabId)?.viewTone ?? null,
);
const activeReviewCommentTone = $derived(
	commentCounts.get(activeTabId)?.totalTone ?? null,
);

// Drop counts for closed tabs so the per-tab map can't grow unbounded across a
// long session. Every close path removes the tab from `tabs`, so pruning against
// the live ids here covers all of them without editing each close function.
$effect(() => {
	const live = new Set(tabs.map((t) => t.id));
	untrack(() => {
		let stale = false;
		for (const id of commentCounts.keys()) {
			if (!live.has(id)) {
				stale = true;
				break;
			}
		}
		if (!stale) return;
		const next = new Map(commentCounts);
		for (const id of next.keys()) {
			if (!live.has(id)) next.delete(id);
		}
		commentCounts = next;
	});
});

// Per-tab state management (App.svelte owns creation, passes as props)
interface TabState {
	remoteState: RemoteState;
	// The commit the tab's graph shows as HEAD, which the toolbar aims Undo at.
	shownHead: { oid: string | null };
	welcome: { error: string | null };
}

const tabStates = new SvelteMap<string, TabState>();

const remoteStatesOfClosedTabs = new Map<string, RemoteState>();

function createTabState(tabId: string, repoPath: string | null = null): void {
	const remoteState = adoptRemoteState(repoPath) ?? createTabRemoteState();

	const shownHead = $state<TabState["shownHead"]>({ oid: null });
	const welcome = $state<TabState["welcome"]>({ error: null });
	tabStates.set(tabId, {
		remoteState,
		shownHead,
		welcome,
	});
}

function createTabRemoteState(): RemoteState {
	const remoteState = createRemoteState(() => {
		const tab = tabs.find(
			(tab) => tabStates.get(tab.id)?.remoteState === remoteState,
		);
		if (tab?.repoPath) autofetch.checked(tab.repoPath);
	});
	return remoteState;
}

function adoptRemoteState(repoPath: string | null): RemoteState | null {
	if (repoPath === null) return null;
	const key = repositoryPathKey(repoPath);
	const running = remoteStatesOfClosedTabs.get(key);
	remoteStatesOfClosedTabs.delete(key);
	if (!running?.isRunning) return null;

	running.closedTabName = null;
	return running;
}

/** Drops a tab's state, keeping a remote operation it still runs for the next
 *  tab that opens its repository. */
function dropTabState(tab: TabInfo): void {
	const remoteState = tabStates.get(tab.id)?.remoteState;
	tabStates.delete(tab.id);
	if (tab.repoPath === null || !remoteState?.isRunning) return;

	remoteState.closedTabName = tab.repoName;
	remoteStatesOfClosedTabs.set(repositoryPathKey(tab.repoPath), remoteState);
}

function getTabState(tabId: string): TabState {
	const state = tabStates.get(tabId);
	if (!state) throw new Error(`Missing state for tab ${tabId}`);
	return state;
}

// Active tab derived
let activeTab = $derived(tabs.find((t) => t.id === activeTabId));

// Tab CRUD functions
function activateTab(id: string) {
	if (updateFrozen) return;
	activeTabId = id;
	persistTabs();
}

function addNewTab() {
	if (updateFrozen) return;
	if (!tabsRestored) {
		newTabRequested = true;
		return;
	}
	const existing = tabs.find((t) => t.repoPath === null);
	if (existing) {
		activateTab(existing.id);
		return;
	}
	const tab: TabInfo = {
		id: createTabId(),
		repoPath: null,
		repoName: "New Tab",
		dirty: false,
	};
	createTabState(tab.id);
	tabs = [...tabs, tab];
	activateTab(tab.id);
}

function closeOtherTabs(keepTabId: string) {
	if (updateFrozen) return;
	const toClose = tabs.filter((t) => t.id !== keepTabId);
	tabs = tabs.filter((t) => t.id === keepTabId);
	for (const t of toClose) {
		if (t.repoPath) {
			void repositories.closeUnused(t.repoPath);
		}
		dropTabState(t);
	}
	activeTabId = keepTabId;
	persistTabs();
}

function reorderTabs(order: TabInfo[]) {
	if (updateFrozen) return;
	tabs = order;
	persistTabs();
}

function closeAllTabs() {
	if (updateFrozen) return;
	const toClose = tabs;
	tabs = [];
	for (const t of toClose) {
		if (t.repoPath) {
			void repositories.closeUnused(t.repoPath);
		}
		dropTabState(t);
	}
	addNewTab();
}

async function showTabContextMenu(tabId: string, _event: MouseEvent) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const tab = tabs.find((t) => t.id === tabId);

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Close Others",
				enabled: tabs.length > 1,
				action: () => {
					closeOtherTabs(tabId);
				},
			}),
			await MenuItem.new({
				text: "Close All",
				action: () => {
					closeAllTabs();
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Copy Path",
				enabled: !!tab?.repoPath,
				action: () => {
					if (tab?.repoPath) copyText(tab.repoPath);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Move Left",
				enabled: canMoveTab(tabs, tabId, -1),
				action: () => reorderTabs(moveTab(tabs, tabId, -1)),
			}),
			await MenuItem.new({
				text: "Move Right",
				enabled: canMoveTab(tabs, tabId, 1),
				action: () => reorderTabs(moveTab(tabs, tabId, 1)),
			}),
		],
	});
	await menu.popup();
}

function repositoryTab(path: string): TabInfo | undefined {
	const key = repositoryPathKey(path);
	return tabs.find((tab) => repositoryPathKey(tab.repoPath) === key);
}

function openRepoInTab(tab: TabInfo, path: string, name: string) {
	const existing = repositoryTab(path);
	if (existing) {
		if (existing.repoPath)
			repositories.opened({ id: existing.id, repoPath: existing.repoPath });
		if (activeTabId === tab.id) activeTabId = existing.id;
		// Close the transient empty tab that triggered the open
		if (!tab.repoPath) {
			tabs = tabs.filter((t) => t.id !== tab.id);
			tabStates.delete(tab.id);
		}
		persistTabs();
		return;
	}

	const previousPath = tab.repoPath;
	// The state describes the previous repository, including its remote operation.
	dropTabState(tab);
	createTabState(tab.id, path);
	repositories.opened({ id: tab.id, repoPath: path });
	tab.repoPath = path;
	tab.repoName = name;
	persistTabs();
	if (previousPath) void repositories.closeUnused(previousPath);
}

function rememberRepositoryInOrder(result: Promise<RecentRepo | null>): void {
	recentRepositoryWrites = trackPending(
		recentRepositoryWrites.then(async () => {
			const repo = await result;
			if (!repo || repositoryTabsDisposed) return;
			try {
				await addRecentRepo(repo);
			} catch (error) {
				if (!repositoryTabsDisposed)
					showToast(
						`Opened ${repo.name}, but could not save it in Recent: ${errorMessage(error, "unknown error")}`,
						"error",
					);
			}
		}),
	);
}

/** Only a tab's latest choice can publish a repository or report an open error. */
async function openRepository(
	tabId: string,
	choice?: RecentRepo,
	fromPicker?: RepositoryPicker,
) {
	const tab = tabs.find(({ id }) => id === tabId);
	if (!tab || updateFrozen || (fromPicker && picker !== fromPicker)) return;

	const previous = pendingOpens.get(tabId);
	previous?.cancel();
	const welcome = fromPicker ? undefined : getTabState(tabId).welcome;
	if (welcome) welcome.error = null;
	let name = choice?.name ?? "repository";
	let remember!: (repo: RecentRepo | null) => void;
	const result = new Promise<RecentRepo | null>((resolve) => {
		remember = resolve;
	});
	const request: PendingOpen = {
		name,
		fromPicker,
		restoreFailure: previous?.restoreFailure,
		cancel: () => remember(null),
	};
	pendingOpens.set(tabId, request);
	rememberRepositoryInOrder(result);
	const isCurrent = () =>
		!repositoryTabsDisposed &&
		pendingOpens.get(tabId) === request &&
		tabs.includes(tab);
	const attach = (openedPath: string) => {
		if (!isCurrent()) return;
		openRepoInTab(tab, openedPath, name);
		remember({ name, path: openedPath });
	};

	let closeAfterChoice = !!choice;
	try {
		let path = choice?.path;
		if (path === undefined) {
			const folder = await open({ directory: true, multiple: false });
			if (typeof folder !== "string" || !isCurrent()) return;
			name = repositoryName(folder);
			const resolved = await repositoryToOpen(folder, isCurrent);
			if (resolved === null || !isCurrent()) return;
			path = resolved;
			name = repositoryName(path);
			closeAfterChoice = true;
		}

		const target = repositoryTab(path);
		if (target && repositories.isReady(target)) {
			if (target.id !== tabId) attach(target.repoPath ?? path);
		} else {
			await repositories.openForTab(target?.repoPath ?? path, attach);
		}
	} catch (error) {
		if (!isCurrent()) return;
		if (welcome)
			welcome.error = errorMessage(error, "Failed to open repository");
		else
			showToast(
				`Could not open ${name}: ${errorMessage(error, "unknown error")}`,
				"error",
			);
	} finally {
		finishOpen(tabId, request, closeAfterChoice);
	}
}

function finishOpen(
	tabId: string,
	request: PendingOpen,
	closeAfterChoice: boolean,
) {
	request.cancel();
	if (pendingOpens.get(tabId) !== request) return;
	pendingOpens.delete(tabId);
	if (closeAfterChoice && picker === request.fromPicker) picker = null;
	const failed = request.restoreFailure;
	if (failed) closeFailedRestore(tabId, failed.path, failed.error);
}

function closeFailedRestore(id: string, path: string, error: unknown) {
	const tab = tabs.find((tab) => tab.id === id && tab.repoPath === path);
	if (!tab || repositories.isReady(tab)) return;
	showToast(
		`Closed the tab for ${tab.repoName} because it could not be opened: ${errorMessage(error, "unknown error")}`,
		"error",
	);
	if (activeTabId === id && initialActiveId === id)
		activeTabId = tabs.find((tab) => tab.id !== id)?.id ?? "";
	closeTab(id);
}

function closePicker(current: RepositoryPicker) {
	if (picker !== current) return;
	picker = null;
	const request = pendingOpens.get(current.tabId);
	if (request?.fromPicker !== current) return;
	finishOpen(current.tabId, request, false);
}

function closeTab(tabId: string) {
	if (updateFrozen) return;
	const idx = tabs.findIndex((t) => t.id === tabId);
	if (idx === -1) return;
	const tab = tabs[idx];
	const repoPath = tab.repoPath;

	// Remove tab from array
	tabs = tabs.filter((t) => t.id !== tabId);

	dropTabState(tab);

	// If last tab closed, add empty tab
	if (tabs.length === 0) {
		addNewTab();
	} else if (activeTabId === tabId) {
		const newIdx = Math.min(idx, tabs.length - 1);
		activeTabId = tabs[newIdx].id;
	}

	// Close repo on backend (after removing from DOM to prevent stale effects)
	if (repoPath) {
		void repositories.closeUnused(repoPath);
	}

	persistTabs();
}

function forceCloseTab(tabId: string) {
	if (updateFrozen) return;
	const tab = tabs.find((t) => t.id === tabId);
	if (!tab) return;
	const repoPath = tab.repoPath;

	// Remove tab from array first
	const idx = tabs.findIndex((t) => t.id === tabId);
	tabs = tabs.filter((t) => t.id !== tabId);

	// Clean up per-tab state
	tabStates.delete(tabId);

	if (tabs.length === 0) {
		addNewTab();
	} else if (activeTabId === tabId) {
		const newIdx = Math.min(idx, tabs.length - 1);
		activeTabId = tabs[newIdx].id;
	}

	// Force close on backend (D-11)
	if (repoPath) {
		void closeRepositoryBackend(repoPath, "force_close_repo");
	}

	persistTabs();
}

let tabSession: TabSession | undefined;
let tabRestoreError = $state<string | null>(null);
let newTabRequested = false;

function tabSnapshot(): TabSnapshot {
	return {
		tabs: tabs.map(({ id, repoPath, repoName }) => ({
			id,
			repoPath,
			repoName,
		})),
		activeTabId,
	};
}

// Dispatch immediately so a later choice is already in native IPC at quit.
function persistTabs() {
	void tabSession?.save(tabSnapshot()).catch((error) => {
		if (!repositoryTabsDisposed) reportTabSaveFailure(error);
	});
}

function reportTabSaveFailure(error: unknown) {
	showToast(
		`Could not save tabs: ${errorMessage(error, "unknown error")}`,
		"error",
	);
}

preparation.register({
	capture: () => {
		const snapshot = tabSnapshot();
		const session = tabSession;
		return {
			generation: JSON.stringify([snapshot, preferenceGeneration()]),
			blocker:
				session && tabsRestored
					? null
					: "Wait for your tabs to finish opening before restarting.",
			flush: async (permit) => {
				await flushPreferencesForUpdate(permit);
				await session?.save(snapshot, permit);
			},
		};
	},
});

// Restore on mount
$effect(() => {
	void copyLegacyUserWidthsOnce();
	void restoreTabs();
});

onDestroy(() => {
	repositoryTabsDisposed = true;
	for (const request of pendingOpens.values()) request.cancel();
	repositories.dispose();
});

async function restoreTabs() {
	tabRestoreError = null;
	try {
		const session = await openTabSession();
		if (repositoryTabsDisposed) return;
		tabSession = session;
		let { tabs: restored, activeTabId: savedActive } = session;

		// Legacy migration: if no tabs but old open_repo exists
		if (restored.length === 0) {
			const legacy = await getOpenRepo();
			if (legacy) {
				const id = createTabId();
				restored = [{ id, repoPath: legacy.path, repoName: legacy.name }];
				savedActive = id;
				if (repositoryTabsDisposed) return;
				try {
					await session.save({ tabs: restored, activeTabId: id });
					await setOpenRepo(null);
				} catch (error) {
					if (!repositoryTabsDisposed) reportTabSaveFailure(error);
				}
			}
		}

		if (repositoryTabsDisposed) return;

		// A backend path has one tab, including when older saved tabs contain duplicates.
		const activePath = repositoryPathKey(
			restored.find((tab) => tab.id === savedActive)?.repoPath ?? null,
		);
		const seenPaths = new Set<string>();
		const uniqueTabs = restored.filter(({ id, repoPath }) => {
			if (repoPath === null) return true;
			const key = repositoryPathKey(repoPath);
			if (seenPaths.has(key) || (key === activePath && id !== savedActive))
				return false;
			seenPaths.add(key);
			return true;
		});
		const restoredTabs: TabInfo[] = uniqueTabs.map((pt) => {
			createTabState(pt.id);
			return {
				id: pt.id,
				repoPath: pt.repoPath,
				repoName: pt.repoName,
				dirty: false,
			};
		});
		repositories.restore(restoredTabs);
		tabs = restoredTabs;
		initialActiveId =
			restoredTabs.find((t) => t.id === savedActive)?.id ??
			restoredTabs[0]?.id ??
			null;
		activeTabId = initialActiveId ?? "";
		tabsRestored = true;
		if (newTabRequested || tabs.length === 0) addNewTab();
	} catch (error) {
		if (!repositoryTabsDisposed)
			tabRestoreError = errorMessage(error, "Unknown error");
	}
}

// Zoom persistence
$effect(() => {
	getZoomLevel().then((level) => {
		zoomLevel = level;
	});
});

// Pane persistence
$effect(() => {
	getLeftPaneWidth().then((w) => {
		leftPaneWidth = w;
	});
	getRightPaneWidth().then((w) => {
		rightPaneWidth = w;
	});
	getLeftPaneCollapsed().then((c) => {
		leftPaneCollapsed = c;
	});
	getRightPaneCollapsed().then((c) => {
		rightPaneCollapsed = c;
	});
	getReviewLeftPaneCollapsed().then((c) => {
		reviewLeftPaneCollapsed = c;
	});
});

// Review filter persistence
$effect(() => {
	getReviewThreadsHidden()
		.then((hidden) => {
			if (!reviewThreadsHiddenChanged && hidden) reviewThreadsHidden = true;
		})
		.catch(() => {
			showToast("Could not load hidden review threads", "error");
		});
});

// Content mode is one global preference and must be known before any RepoView
// can issue its first mode-bound diff request.
$effect(() => {
	getDiffContentMode()
		.then((mode) => {
			if (!diffContentModeChanged) diffContentMode = mode;
		})
		.catch(() => {
			showToast("Could not load diff content mode", "error");
		})
		.finally(() => {
			diffContentModeLoaded = true;
		});
});

$effect(() => {
	void DiffPreferences.load().then((preferences) => {
		diffPreferences = preferences;
	});
});

// Track fullscreen state (hide traffic-light padding when fullscreen)
$effect(() => {
	const appWindow = getCurrentWindow();
	appWindow.isFullscreen().then((fs) => {
		isFullscreen = fs;
	});

	let unlisten: (() => void) | undefined;
	appWindow
		.onResized(async () => {
			isFullscreen = await appWindow.isFullscreen();
		})
		.then((fn) => {
			unlisten = fn;
		});

	return () => {
		unlisten?.();
	};
});

// Pause automatic fetches while the window is unfocused.
$effect(() => {
	const appWindow = getCurrentWindow();
	let disposed = false;
	let focusChanged = false;
	appWindow.isFocused().then((focused) => {
		if (!disposed && !focusChanged) windowFocused = focused;
	});

	let unlistenFocus: (() => void) | undefined;
	appWindow
		.onFocusChanged(({ payload: focused }) => {
			if (disposed) return;
			focusChanged = true;
			windowFocused = focused;
		})
		.then((fn) => {
			if (disposed) fn();
			else unlistenFocus = fn;
		});

	return () => {
		disposed = true;
		unlistenFocus?.();
	};
});

// Apply zoom to webview, and tell the backend so it can re-center the macOS
// traffic lights — their on-screen size is fixed, so the inset must track the
// zoom-scaled top bar height.
$effect(() => {
	getCurrentWebview().setZoom(zoomLevel);
	void safeInvoke("set_traffic_light_zoom", { zoom: zoomLevel }).catch(
		() => {},
	);
});

/** Cmd+1..Cmd+8 pick a tab by position; Cmd+9 picks the last tab (TAB-04). */
const TAB_SLOT_CHORD = /^Meta\+([1-9])$/;

function activateTabSlot(slot: number) {
	const idx =
		slot === 9 ? tabs.length - 1 : Math.min(slot - 1, tabs.length - 1);
	if (idx >= 0) activateTab(tabs[idx].id);
}

function activateNeighbourTab(step: 1 | -1) {
	if (tabs.length === 0) return;
	const cur = tabs.findIndex((t) => t.id === activeTabId);
	activateTab(tabs[(cur + step + tabs.length) % tabs.length].id);
}

function changeLeftPaneCollapsed(collapsed: boolean) {
	if (reviewPanelOpen) {
		reviewLeftPaneCollapsed = collapsed;
		setReviewLeftPaneCollapsed(collapsed);
		return;
	}

	leftPaneCollapsed = collapsed;
	setLeftPaneCollapsed(collapsed);
}

// Review mode has no detail pane, so nothing in it may close the graph's.
function changeRightPaneCollapsed(collapsed: boolean) {
	if (reviewPanelOpen) return;

	rightPaneCollapsed = collapsed;
	setRightPaneCollapsed(collapsed);
}

function applyZoom(level: number) {
	zoomLevel = level;
	setZoomLevel(level);
}

// On macOS a Ctrl+letter chord typed into a text field is the field's own line
// editing (Ctrl+A, Ctrl+E, Ctrl+K and the rest of Cocoa's key bindings).
function ctrlEditsText(chord: string): boolean {
	return (
		/^Ctrl\+[a-z]$/.test(chord) &&
		onMac() &&
		focusInEditable(document.activeElement)
	);
}

// Keyboard shortcuts
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (updateFrozen) return;
		const chord = keyChord(e);
		const tabSlot = TAB_SLOT_CHORD.exec(chord);
		if (tabSlot) {
			e.preventDefault();
			activateTabSlot(Number(tabSlot[1]));
			return;
		}
		if (ctrlEditsText(chord)) return;

		switch (chord) {
			case "Meta+t":
				e.preventDefault();
				addNewTab();
				return;
			case "Meta+w":
				e.preventDefault();
				closeTab(activeTabId);
				return;
			case "Meta+Shift+w":
				e.preventDefault();
				forceCloseTab(activeTabId);
				return;
			case "Ctrl+Tab":
				e.preventDefault();
				activateNeighbourTab(1);
				return;
			case "Ctrl+Shift+Tab":
				e.preventDefault();
				activateNeighbourTab(-1);
				return;
			case "Meta+r":
			case "Ctrl+r":
				if (!activeTabId || focusInEditable(document.activeElement)) return;
				e.preventDefault();
				picker ??= { tabId: activeTabId };
				return;
			case "Meta+=":
			case "Meta++":
			case "Meta+Shift++":
			case "Ctrl+=":
			case "Ctrl++":
			case "Ctrl+Shift++":
				e.preventDefault();
				applyZoom(+Math.min(3, zoomLevel + 0.1).toFixed(1));
				return;
			case "Meta+-":
			case "Ctrl+-":
				e.preventDefault();
				applyZoom(+Math.max(0.5, zoomLevel - 0.1).toFixed(1));
				return;
			case "Meta+0":
			case "Ctrl+0":
				e.preventDefault();
				applyZoom(1);
				return;
			case "Meta+j":
			case "Ctrl+j":
				e.preventDefault();
				changeLeftPaneCollapsed(
					reviewPanelOpen ? !reviewLeftPaneCollapsed : !leftPaneCollapsed,
				);
				return;
			case "Meta+k":
			case "Ctrl+k":
				e.preventDefault();
				changeRightPaneCollapsed(!rightPaneCollapsed);
				return;
		}
	}
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

async function closeUnusedRepository(path: string): Promise<void> {
	if (!repositoryTabsDisposed && tabs.some((tab) => tab.repoPath === path))
		return;

	await closeRepositoryBackend(path, "close_repo");
}

async function openRepositoryBackend(path: string): Promise<void> {
	const closing = closingRepositories.get(path);
	if (closing) await closing;
	await safeInvoke<void>("open_repo", { path });
}

function closeRepositoryBackend(
	path: string,
	command: "close_repo" | "force_close_repo",
): Promise<void> {
	const closing = closingRepositories.get(path);
	if (closing) return closing;

	async function close() {
		// Let the old sidebar unmount, then join its graph work and any saves it started.
		await tick();
		await visibilityJobsSettled(path);
		await refVisibilityWritesSettled(path);
		await safeInvoke<void>(command, { path }).catch(() => {});
	}
	const done = trackPending(close()).finally(() =>
		closingRepositories.delete(path),
	);
	closingRepositories.set(path, done);
	return done;
}

function isRepoViewMounted(tab: TabInfo): boolean {
	return diffSettingsLoaded && repositories.wasVisited(tab);
}

function updateDirtyBadge(
	tab: TabInfo,
	counts: { staged: number; unstaged: number },
) {
	tab.dirty = counts.staged + counts.unstaged > 0;
}

// Unvisited tabs have no RepoView to publish counts for their badges.
$effect(() => {
	const livePaths = new Set(
		tabs.flatMap((tab) => (tab.repoPath ? [tab.repoPath] : [])),
	);
	untrack(() => {
		for (const [path, refresh] of dirtyCountRefreshes) {
			if (livePaths.has(path)) continue;
			refresh.dispose();
			dirtyCountRefreshes.delete(path);
		}
	});
});

$effect(() => {
	let disposed = false;
	let unlisten: (() => void) | undefined;

	function refreshFor(repoPath: string): CoalescedTask {
		let refresh = dirtyCountRefreshes.get(repoPath);
		if (refresh) return refresh;

		refresh = createCoalescedTask(scheduler, async () => {
			const tab = tabs.find((candidate) => candidate.repoPath === repoPath);
			if (!tab) return;
			try {
				const counts = await safeInvoke<{
					staged: number;
					unstaged: number;
					conflicted: number;
				}>("get_dirty_counts", { path: repoPath });
				if (tabs.includes(tab) && !isRepoViewMounted(tab)) {
					updateDirtyBadge(tab, counts);
				}
			} catch {
				// Non-fatal: keep the previous dirty state.
			}
		});
		dirtyCountRefreshes.set(repoPath, refresh);
		return refresh;
	}

	listen<RepoChanged>("repo-changed", (event) => {
		if (event.payload.refs_only) return;
		const repoPath = event.payload.repo;
		const tab = tabs.find((t) => t.repoPath === repoPath);
		if (!tab) return;
		if (isRepoViewMounted(tab)) return;
		requestRepoChange(refreshFor(repoPath), event.payload);
	}).then((fn) => {
		if (disposed) fn();
		else unlisten = fn;
	});

	return () => {
		disposed = true;
		unlisten?.();
		for (const refresh of dirtyCountRefreshes.values()) refresh.dispose();
		dirtyCountRefreshes.clear();
	};
});

$effect(() => {
	let disposed = false;
	let unlisten: (() => void) | undefined;
	listen<{ repo: string }>("watch-unavailable", ({ payload }) => {
		const name = repositoryName(payload.repo);
		showToast(
			`Changes made outside Trunk won't show in ${name} until you close it and open it again.`,
			"error",
		);
	}).then((fn) => {
		if (disposed) fn();
		else unlisten = fn;
	});
	return () => {
		disposed = true;
		unlisten?.();
	};
});

// Review mode is a window toggle. Each visited RepoView keeps the review it
// opened until the window leaves review mode.
$effect(() => {
	let unlisten: (() => void) | undefined;
	listen<void>("review-toggle", () => {
		if (updateFrozen) return;
		reviewPanelOpen = !reviewPanelOpen;
	}).then((fn) => {
		unlisten = fn;
	});
	return () => {
		unlisten?.();
	};
});
</script>

<div class="flex flex-col h-screen bg-bg" inert={updateFrozen}>
	<!-- LAYOUT-02: unified title bar + toolbar -->
	<header
		data-tauri-drag-region
		class="flex items-center flex-shrink-0 h-topbar bg-surface shadow-hairline"
		style:padding-left="{isFullscreen ? 0 : 78 / zoomLevel}px"
	>
		<TabBar
			{tabs}
			{activeTabId}
			onactivate={activateTab}
			onclose={(id, force) => {
				if (force) forceCloseTab(id);
				else closeTab(id);
			}}
			onnew={addNewTab}
			oncontextmenu={showTabContextMenu}
			onauxclose={(id) => closeTab(id)}
			onreorder={reorderTabs}
		/>
		<div data-tauri-drag-region class="flex-1 min-w-6 h-full"></div>
		{#if activeTab?.repoPath && repositories.isReady(activeTab)}
			{@const activeState = getTabState(activeTabId)}
			<Toolbar
				repoPath={activeTab.repoPath}
				remoteState={activeState.remoteState}
				shownHeadOid={activeState.shownHead.oid}
				reviewActive={reviewPanelOpen}
				reviewPanelShowing={activeReviewPanelShowing}
				{reviewThreadsHidden}
				viewCommentCount={activeInlineCommentCount}
				reviewCommentCount={activeReviewCommentCount}
				viewCommentTone={activeInlineCommentTone}
				reviewCommentTone={activeReviewCommentTone}
				onreviewthreadshiddenchange={handleReviewThreadsHiddenChange}
			/>
		{/if}
		{#if updateOpen ||
			updateFrozen ||
			(updateStatus &&
				["available", "downloading", "ready", "recovery"].includes(
					updateStatus.phase,
				))}
			<div class="flex shrink-0 items-center border-l border-border pl-2 pr-3">
				<UpdateControl
					status={updateStatus}
					busy={updateBusy}
					frozen={updateFrozen}
					waiting={restartWaiting}
					bind:open={updateOpen}
					onclose={() => (confirmUpdateVersion = null)}
					oncheck={() => void updateAction(updates.check)}
					ondownload={downloadUpdate}
					onrestart={(version) => {
						confirmUpdateVersion = version;
						updateOpen = true;
					}}
				>
					{#snippet children(closePanel)}
						<UpdatePanel
							status={updateStatus}
							busy={updateBusy}
							frozen={updateFrozen}
							waiting={restartWaiting}
							error={updateError}
							confirmVersion={confirmUpdateVersion}
							retry={updateRetry
								? {
										label:
											updateRetry === "readiness"
												? "Retry startup verification"
												: "Retry update status",
										run: () => void retryStartupUpdate(),
									}
								: undefined}
							onclose={closePanel}
							onenable={() => void updateAction(() => updates.enable(true))}
							oncheck={() => void updateAction(updates.check)}
							ondownload={downloadUpdate}
							onrestart={(version) => {
								confirmUpdateVersion = version;
								updateOpen = true;
							}}
							onconfirmcancel={() => (confirmUpdateVersion = null)}
							onwaitcancel={() => preparation.cancel()}
							onconfirm={(version) => {
								if (
									version !== confirmUpdateVersion ||
									updateStatus?.phase !== "ready" ||
									updateStatus.version !== version
								)
									return;

								confirmUpdateVersion = null;
								updateOpen = true;
								void updateAction(async () => {
									await preparation.install(version);
									return undefined;
								});
							}}
							oncancel={() =>
								void updates
									.cancel()
									.then(acceptUpdateStatus)
									.catch((error) => {
										updateError = errorMessage(
											error,
											"Download cancellation failed.",
										);
									})}
						/>
					{/snippet}
				</UpdateControl>
			</div>
		{/if}
	</header>

	<div class="flex-1 overflow-hidden relative">
		{#if tabRestoreError !== null}
			<div
				class="h-full flex flex-col items-center justify-center gap-3 p-4 text-body"
			>
				<p role="alert">Could not restore tabs. {tabRestoreError}</p>
				<Button onclick={() => void restoreTabs()}>Retry opening tabs</Button>
			</div>
		{/if}
		{#each tabViews as tab (tab.id)}
			<div
				class="absolute inset-0 flex flex-col"
				class:invisible={tab.id !== activeTabId}
				class:pointer-events-none={tab.id !== activeTabId}
			>
				{#if tab.repoPath}
					{#if diffPreferences && isRepoViewMounted(tab)}
						{#key tab.repoPath}
							{@const tabState = getTabState(tab.id)}
							<RepoView
								repoPath={tab.repoPath}
								remoteState={tabState.remoteState}
								{leftPaneWidth}
								{leftPaneCollapsed}
								{reviewLeftPaneCollapsed}
								{rightPaneWidth}
								{rightPaneCollapsed}
								tabActive={tab.id === activeTabId}
								{windowFocused}
								reviewActive={reviewPanelOpen}
								{reviewThreadsHidden}
								{threadFilter}
								onthreadfilterchange={(filter) => {
									threadFilter = filter;
								}}
								contentMode={diffContentMode}
								oncontentmodechange={handleDiffContentModeChange}
								{diffPreferences}
								oncommentcountschange={(c) => setCommentCounts(tab.id, c)}
								onshownheadchange={(oid) => {
									tabState.shownHead.oid = oid;
								}}
								onreviewpanelshowingchange={(s) => {
									activeReviewPanelShowing = s;
								}}
								onleftpanecollapsedchange={changeLeftPaneCollapsed}
								onrightpanecollapsedchange={changeRightPaneCollapsed}
								onleftpanewidthchange={(w) => {
									leftPaneWidth = w;
								}}
								onrightpanewidthchange={(w) => {
									rightPaneWidth = w;
								}}
								onleavereview={() => {
									reviewPanelOpen = false;
								}}
								onready={() => {
									if (tab.repoPath) repositories.viewReady(tab);
								}}
								onrecoveryready={(error) => {
									if (tab.repoPath)
										recoveredRepositories.set(tab.id, {
											path: tab.repoPath,
											error,
										});
									if (error) {
										updateError = error;
										updateOpen = true;
									}
								}}
								ondirtychange={(counts) => {
									updateDirtyBadge(tab, counts);
								}}
							/>
						{/key}
					{:else}
						<div
							role="status"
							aria-label="Loading repository"
							class="flex-1 flex items-center justify-center text-text-subtle text-body"
						>
							Loading repository…
						</div>
					{/if}
				{:else}
					<WelcomeScreen
						opening={pendingOpens.has(tab.id)}
						error={getTabState(tab.id).welcome.error}
						onopen={(choice) => openRepository(tab.id, choice)}
					/>
				{/if}
			</div>
		{/each}
	</div>

	{#key picker}
		{#if picker}
			{@const current = picker}
			<RecentReposPicker
				open={true}
				openingName={pendingOpens.get(current.tabId)?.name}
				onpick={(choice) => openRepository(current.tabId, choice, current)}
				onclose={() => closePicker(current)}
			/>
		{/if}
	{/key}

	<Toast />
</div>
