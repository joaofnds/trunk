<script lang="ts">
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tick, untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import RecentReposPicker from "./components/RecentReposPicker.svelte";
import RepoView from "./components/RepoView.svelte";
import TabBar from "./components/TabBar.svelte";
import Toast from "./components/Toast.svelte";
import Toolbar from "./components/Toolbar.svelte";
import WelcomeScreen from "./components/WelcomeScreen.svelte";
import { AutofetchScheduler } from "./lib/autofetch.js";
import type { FetchReport } from "./lib/autofetch-status.js";
import { copyText } from "./lib/clipboard.js";
import {
	type CoalescedTask,
	createCoalescedTask,
} from "./lib/coalesced-task.js";
import { safeInvoke } from "./lib/invoke.js";
import { focusInEditable, keyChord } from "./lib/keyboard.js";
import { perfEnabled, record } from "./lib/perf.js";
import {
	createRemoteState,
	type RemoteState,
} from "./lib/remote-state.svelte.js";
import type { RepoChanged } from "./lib/repo-change-subscription.js";
import { RepositoryTabs } from "./lib/repository-tabs.svelte.js";
import { ALL_THREADS } from "./lib/review-filter.js";
import { getScheduler } from "./lib/scheduler.js";
import {
	addRecentRepo,
	copyLegacyUserWidthsOnce,
	getActiveTabId,
	getDiffContentMode,
	getFetchIntervalMs,
	getLeftPaneCollapsed,
	getLeftPaneWidth,
	getOpenRepo,
	getOpenTabs,
	getReviewLeftPaneCollapsed,
	getReviewThreadsHidden,
	getRightPaneCollapsed,
	getRightPaneWidth,
	getZoomLevel,
	removeRecentRepo,
	setActiveTabId,
	setDiffContentMode,
	setLeftPaneCollapsed,
	setLeftPaneWidth,
	setOpenRepo,
	setOpenTabs,
	setReviewLeftPaneCollapsed,
	setReviewThreadsHidden,
	setRightPaneCollapsed,
	setRightPaneWidth,
	setZoomLevel,
	subscribeFetchInterval,
} from "./lib/store.js";
import type { TabInfo } from "./lib/tab-types.js";
import { createTabId } from "./lib/tab-types.js";
import { showToast } from "./lib/toast.svelte.js";
import type { ContentMode, ReviewTone, ThreadFilter } from "./lib/types.js";
import {
	createUndoRedoState,
	type UndoRedoManager,
} from "./lib/undo-redo.svelte.js";

// Global layout state (D-01, D-02, D-03)
let zoomLevel = $state(1);
let leftPaneWidth = $state(220);
let leftPaneCollapsed = $state(false);
let rightPaneWidth = $state(240);
let rightPaneCollapsed = $state(false);
let reviewLeftPaneCollapsed = $state(false);
let isFullscreen = $state(false);
let windowVisible = $state(false);

// Recent-projects picker (quick-260514-356)
let pickerOpen = $state(false);

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
let activeTabId = $state<string>("");
let initialActiveId: string | null = null;
const scheduler = getScheduler();
const autofetch = new AutofetchScheduler(scheduler, runAutofetch);
let repositoryTabsDisposed = false;
const dirtyCountRefreshes = new Map<string, CoalescedTask>();
const repositories = new RepositoryTabs(scheduler, {
	open: (path) => safeInvoke<void>("open_repo", { path }),
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
	failed: (id) => {
		if (activeTabId === id && initialActiveId === id)
			activeTabId = tabs.find((tab) => tab.id !== id)?.id ?? "";
		closeTab(id);
	},
});

$effect(() => {
	const currentTabs = tabs.map(({ id, repoPath }) => ({
		id,
		repoPath,
	}));
	const active = activeTabId;
	if (initialActiveId !== active) initialActiveId = null;
	untrack(() => repositories.update(currentTabs, active));
});

async function runAutofetch(path: string, intervalMs: number): Promise<void> {
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
	const focused = windowVisible;
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
	undoRedo: UndoRedoManager;
}

const tabStates = new SvelteMap<string, TabState>();

function createTabState(tabId: string): void {
	const remoteState = createRemoteState(() => {
		const tab = tabs.find((tab) => tab.id === tabId);
		if (tab?.repoPath && tabStates.get(tabId)?.remoteState === remoteState)
			autofetch.checked(tab.repoPath);
	});

	tabStates.set(tabId, {
		remoteState,
		undoRedo: createUndoRedoState(),
	});
}

function getTabState(tabId: string): TabState {
	const state = tabStates.get(tabId);
	if (!state) throw new Error(`Missing state for tab ${tabId}`);
	return state;
}

// Active tab derived
let activeTab = $derived(tabs.find((t) => t.id === activeTabId));

// Tab CRUD functions
function addNewTab() {
	const existing = tabs.find((t) => t.repoPath === null);
	if (existing) {
		activeTabId = existing.id;
		persistTabs();
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
	activeTabId = tab.id;
	persistTabs();
}

function closeOtherTabs(keepTabId: string) {
	const toClose = tabs.filter((t) => t.id !== keepTabId);
	tabs = tabs.filter((t) => t.id === keepTabId);
	for (const t of toClose) {
		if (t.repoPath) {
			void closeUnusedRepository(t.repoPath);
		}
		tabStates.delete(t.id);
	}
	activeTabId = keepTabId;
	persistTabs();
}

function closeAllTabs() {
	const toClose = tabs;
	tabs = [];
	for (const t of toClose) {
		if (t.repoPath) {
			void closeUnusedRepository(t.repoPath);
		}
		tabStates.delete(t.id);
	}
	addNewTab();
}

async function showTabContextMenu(tabId: string, _event: MouseEvent) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
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
		],
	});
	await menu.popup();
}

async function openRepoInTab(tabId: string, path: string, name: string) {
	// TAB-10: Duplicate detection — switch to existing tab instead of creating duplicate
	const normalizedPath = repositoryPathKey(path);
	const existing = tabs.find(
		(t) => t.repoPath && repositoryPathKey(t.repoPath) === normalizedPath,
	);
	if (existing) {
		activeTabId = existing.id;
		// Close the transient empty tab that triggered the open
		const triggerTab = tabs.find((t) => t.id === tabId);
		if (triggerTab && !triggerTab.repoPath) {
			tabs = tabs.filter((t) => t.id !== tabId);
			tabStates.delete(tabId);
		}
		persistTabs();
		return;
	}

	const tab = tabs.find((t) => t.id === tabId);
	if (tab) {
		const previousPath = tab.repoPath;
		// Every field of a tab's state describes the repository it was gathered
		// in: an in-flight pull, its progress line, its failure, the undone
		// commit. Dropping the whole thing is what keeps a stale field from
		// following the tab to a repository it says nothing about — a pull still
		// marked running would leave the incoming repository's Pull and Push
		// disabled with no way back.
		tabStates.delete(tabId);
		createTabState(tabId);
		repositories.opened({ id: tabId, repoPath: path });
		tab.repoPath = path;
		tab.repoName = name;
		persistTabs();
		if (previousPath) {
			await tick();
			void closeUnusedRepository(previousPath);
		}
	}
}

async function handlePickerPick(path: string, name: string) {
	// No-op if the active tab already shows this repo (CONTEXT.md decision).
	if (activeTab?.repoPath === path) {
		pickerOpen = false;
		return;
	}
	if (
		tabs.some(
			(tab) => repositoryPathKey(tab.repoPath) === repositoryPathKey(path),
		)
	) {
		await addRecentRepo({ name, path });
		await openRepoInTab(activeTabId, path, name);
		pickerOpen = false;
		return;
	}
	try {
		await safeInvoke("open_repo", { path });
	} catch {
		// Path slipped past the prune step (race or transient). Drop it
		// silently — picker stays quiet by design.
		await removeRecentRepo(path);
		pickerOpen = false;
		return;
	}
	await addRecentRepo({ name, path });
	await openRepoInTab(activeTabId, path, name);
	pickerOpen = false;
}

function closeTab(tabId: string) {
	const idx = tabs.findIndex((t) => t.id === tabId);
	if (idx === -1) return;
	const tab = tabs[idx];
	const repoPath = tab.repoPath;

	// Remove tab from array
	tabs = tabs.filter((t) => t.id !== tabId);

	// Clean up per-tab state
	tabStates.delete(tabId);

	// If last tab closed, add empty tab
	if (tabs.length === 0) {
		addNewTab();
	} else if (activeTabId === tabId) {
		const newIdx = Math.min(idx, tabs.length - 1);
		activeTabId = tabs[newIdx].id;
	}

	// Close repo on backend (after removing from DOM to prevent stale effects)
	if (repoPath) {
		void closeUnusedRepository(repoPath);
	}

	persistTabs();
}

function forceCloseTab(tabId: string) {
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
		safeInvoke("force_close_repo", { path: repoPath }).catch(() => {});
	}

	persistTabs();
}

// Tab persistence — both saves fire immediately so they survive Cmd+Q
function persistTabs() {
	setActiveTabId(activeTabId);
	setOpenTabs(
		tabs.map((t) => ({
			id: t.id,
			repoPath: t.repoPath,
			repoName: t.repoName,
		})),
	);
}

// Restore on mount
$effect(() => {
	void copyLegacyUserWidthsOnce();
	let disposed = false;

	(async () => {
		let [restored, savedActive] = await Promise.all([
			getOpenTabs(),
			getActiveTabId(),
		]);

		// Legacy migration: if no tabs but old open_repo exists
		if (restored.length === 0) {
			const legacy = await getOpenRepo();
			if (legacy) {
				const id = createTabId();
				restored = [{ id, repoPath: legacy.path, repoName: legacy.name }];
				await setOpenTabs(restored);
				await setOpenRepo(null); // clear legacy key
			}
		}

		if (disposed) return;
		if (restored.length === 0) {
			addNewTab();
			return;
		}

		const restoredTabs: TabInfo[] = restored.map((pt) => {
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
			restoredTabs.find((t) => t.id === savedActive)?.id ?? restoredTabs[0].id;
		activeTabId = initialActiveId;
	})();
	return () => {
		disposed = true;
		repositoryTabsDisposed = true;
		repositories.dispose();
	};
});

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
		if (!disposed && !focusChanged) windowVisible = focused;
	});

	let unlistenFocus: (() => void) | undefined;
	appWindow
		.onFocusChanged(({ payload: focused }) => {
			if (disposed) return;
			focusChanged = true;
			windowVisible = focused;
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
	if (idx >= 0 && idx < tabs.length) activeTabId = tabs[idx].id;
}

function activateNeighbourTab(step: 1 | -1) {
	const cur = tabs.findIndex((t) => t.id === activeTabId);
	activeTabId = tabs[(cur + step + tabs.length) % tabs.length].id;
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

// Keyboard shortcuts
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		const chord = keyChord(e);
		const tabSlot = TAB_SLOT_CHORD.exec(chord);
		if (tabSlot) {
			e.preventDefault();
			activateTabSlot(Number(tabSlot[1]));
			return;
		}

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
				if (focusInEditable(document.activeElement)) return;
				e.preventDefault();
				pickerOpen = true;
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

function repositoryPathKey(path: string | null): string | null {
	return path?.replace(/\/+$/, "") ?? null;
}

async function closeUnusedRepository(path: string): Promise<void> {
	if (!repositoryTabsDisposed && tabs.some((tab) => tab.repoPath === path))
		return;

	await safeInvoke<void>("close_repo", { path }).catch(() => {});
}

function isRepoViewMounted(tab: TabInfo): boolean {
	return diffContentModeLoaded && repositories.wasVisited(tab);
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
		refreshFor(repoPath).invalidate();
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

// Review mode toggle (Phase 69): the View-menu "Start/End Code Review" item
// emits review-toggle (registered in Rust, Plan 65-03). The flag is owned here
// at the App level so this window-global event only flips the ACTIVE tab into
// review mode; RepoView receives it as `reviewActive` and drives the center-pane
// review panel via the review-session rune. Mirrors the search-toggle listener.
$effect(() => {
	let unlisten: (() => void) | undefined;
	listen<void>("review-toggle", () => {
		reviewPanelOpen = !reviewPanelOpen;
	}).then((fn) => {
		unlisten = fn;
	});
	return () => {
		unlisten?.();
	};
});
</script>

<div class="flex flex-col h-screen bg-bg">
	<!-- LAYOUT-02: unified title bar + toolbar -->
	<div
		data-tauri-drag-region
		class="flex items-center flex-shrink-0 h-topbar bg-surface shadow-hairline"
		style:padding-left="{isFullscreen ? 0 : 78 / zoomLevel}px"
	>
		<TabBar
			{tabs}
			{activeTabId}
			onactivate={(id) => { activeTabId = id; persistTabs(); }}
			onclose={(id, force) => { if (force) forceCloseTab(id); else closeTab(id); }}
			onnew={addNewTab}
			oncontextmenu={showTabContextMenu}
			onauxclose={(id) => closeTab(id)}
			onreorder={(newTabs) => { tabs = newTabs; persistTabs(); }}
		/>
		<div data-tauri-drag-region class="flex-1 h-full"></div>
		{#if activeTab?.repoPath && repositories.isReady(activeTab)}
			{@const activeState = getTabState(activeTabId)}
			<Toolbar
				repoPath={activeTab.repoPath}
				remoteState={activeState.remoteState}
				undoRedo={activeState.undoRedo}
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
	</div>

	<div class="flex-1 overflow-hidden relative">
		{#each tabs as tab (tab.id)}
			<div
				class="absolute inset-0 flex flex-col"
				class:invisible={tab.id !== activeTabId}
				class:pointer-events-none={tab.id !== activeTabId}
			>
				{#if tab.repoPath}
					{#if isRepoViewMounted(tab)}
						{#key tab.repoPath}
							{@const tabState = getTabState(tab.id)}
							{@const tabReviewActive = reviewPanelOpen && tab.id === activeTabId}
							<RepoView
								repoPath={tab.repoPath}
								repoName={tab.repoName}
								remoteState={tabState.remoteState}
								undoRedo={tabState.undoRedo}
								{leftPaneWidth}
								leftPaneCollapsed={tabReviewActive ? reviewLeftPaneCollapsed : leftPaneCollapsed}
								{rightPaneWidth}
								{rightPaneCollapsed}
								tabActive={tab.id === activeTabId}
								windowFocused={windowVisible}
								reviewActive={tabReviewActive}
								{reviewThreadsHidden}
								{threadFilter}
								onthreadfilterchange={(filter) => { threadFilter = filter; }}
								contentMode={diffContentMode}
								oncontentmodechange={handleDiffContentModeChange}
								oncommentcountschange={(c) => setCommentCounts(tab.id, c)}
								onreviewpanelshowingchange={(s) => { activeReviewPanelShowing = s; }}
								onleftpanecollapsedchange={changeLeftPaneCollapsed}
								onrightpanecollapsedchange={changeRightPaneCollapsed}
								onleftpanewidthchange={(w) => { leftPaneWidth = w; setLeftPaneWidth(w); }}
								onrightpanewidthchange={(w) => { rightPaneWidth = w; setRightPaneWidth(w); }}
								onleavereview={() => { reviewPanelOpen = false; }}
								onready={() => { if (tab.repoPath) repositories.viewReady(tab); }}
								ondirtychange={(counts) => { updateDirtyBadge(tab, counts); }}
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
						{isFullscreen}
						onopen={(path, name) => { void openRepoInTab(tab.id, path, name); }}
					/>
				{/if}
			</div>
		{/each}
	</div>

	<RecentReposPicker
		open={pickerOpen}
		onpick={handlePickerPick}
		onclose={() => (pickerOpen = false)}
	/>

	<Toast />
</div>
