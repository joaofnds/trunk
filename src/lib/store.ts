import { writable } from "svelte/store";
import {
	type ColumnFloors,
	type ColumnWidths,
	isSizedColumn,
	isUserWidthsRecord,
	sanitizeLegacyColumnWidths,
	sanitizeUserWidths,
} from "./column-widths.js";
import { safeInvoke } from "./invoke.js";
import { EVERYTHING_VISIBLE, type RefVisibility } from "./ref-visibility.js";
import type { PersistedTab } from "./tab-types.js";
import type { ContentMode, LayoutMode, RenderMode } from "./types.js";
import { readReviewUpdateSnapshot } from "./updates-review.js";

export type { PersistedTab } from "./tab-types.js";

export interface RecentRepo {
	name: string;
	path: string;
}

// Prefs live in a Rust-side map backed by trunk-prefs.json; every set
// rewrites the file atomically in one prefs_set call.
async function getPref<T>(key: string, permit?: string): Promise<T | null> {
	return await safeInvoke<T | null>("prefs_get", {
		key,
		...(permit === undefined ? {} : { __updatePermit: permit }),
	});
}

const pendingPreferences = new Set<Promise<void>>();
const requestedPreferences = new Map<string, unknown>();
let preferenceRevision = 0;

async function setPref(
	key: string,
	value: unknown,
	permit?: string,
): Promise<void> {
	requestedPreferences.set(key, value);
	preferenceRevision += 1;
	const write = safeInvoke<void>("prefs_set", {
		key,
		value,
		...(permit === undefined ? {} : { __updatePermit: permit }),
	});
	pendingPreferences.add(write);
	try {
		await write;
	} finally {
		pendingPreferences.delete(write);
	}
}

export function preferenceGeneration(): number {
	return preferenceRevision;
}

export async function flushPreferencesForUpdate(
	permit: string,
	tabs: PersistedTab[],
	activeTabId: string,
): Promise<void> {
	await columnLayoutQueue;
	await refVisibilityQueue;
	await Promise.all([
		sharedColumnVisibility.settled(),
		sharedTreeView.settled(),
	]);
	await Promise.allSettled([...pendingPreferences]);
	const values = new Map(requestedPreferences);
	values.delete(COMMIT_DRAFTS_KEY);
	values.set(TABS_KEY, tabs);
	values.set(ACTIVE_TAB_KEY, activeTabId);
	for (const [key, value] of values) {
		await safeInvoke("prefs_set", { key, value, __updatePermit: permit });
	}
}

const RECENT_KEY = "recent_repos";
const TABS_KEY = "open_tabs";

export async function addRecentRepo(repo: RecentRepo): Promise<void> {
	const current = (await getPref<RecentRepo[]>(RECENT_KEY)) ?? [];
	const updated = [repo, ...current.filter((r) => r.path !== repo.path)];
	await setPref(RECENT_KEY, updated);
}

export async function getRecentRepos(): Promise<RecentRepo[]> {
	return (await getPref<RecentRepo[]>(RECENT_KEY)) ?? [];
}

export async function removeRecentRepo(path: string): Promise<void> {
	const current = (await getPref<RecentRepo[]>(RECENT_KEY)) ?? [];
	const updated = current.filter((r) => r.path !== path);
	await setPref(RECENT_KEY, updated);
}

const ZOOM_KEY = "zoom_level";

export async function getZoomLevel(): Promise<number> {
	return (await getPref<number>(ZOOM_KEY)) ?? 1;
}

export async function setZoomLevel(level: number): Promise<void> {
	await setPref(ZOOM_KEY, level);
}

const LEFT_PANE_KEY = "left_pane_width";
const RIGHT_PANE_KEY = "right_pane_width";

export const DEFAULT_LEFT_PANE_WIDTH = 220;
export const DEFAULT_RIGHT_PANE_WIDTH = 280;

export async function getLeftPaneWidth(): Promise<number> {
	return (await getPref<number>(LEFT_PANE_KEY)) ?? DEFAULT_LEFT_PANE_WIDTH;
}

export async function setLeftPaneWidth(width: number): Promise<void> {
	await setPref(LEFT_PANE_KEY, width);
}

export async function getRightPaneWidth(): Promise<number> {
	return (await getPref<number>(RIGHT_PANE_KEY)) ?? DEFAULT_RIGHT_PANE_WIDTH;
}

export async function setRightPaneWidth(width: number): Promise<void> {
	await setPref(RIGHT_PANE_KEY, width);
}

const LEFT_PANE_COLLAPSED_KEY = "left_pane_collapsed";
const RIGHT_PANE_COLLAPSED_KEY = "right_pane_collapsed";
const REVIEW_LEFT_PANE_COLLAPSED_KEY = "review_left_pane_collapsed";

export async function getLeftPaneCollapsed(): Promise<boolean> {
	return (await getPref<boolean>(LEFT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setLeftPaneCollapsed(collapsed: boolean): Promise<void> {
	await setPref(LEFT_PANE_COLLAPSED_KEY, collapsed);
}

export async function getReviewLeftPaneCollapsed(): Promise<boolean> {
	return (await getPref<boolean>(REVIEW_LEFT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setReviewLeftPaneCollapsed(
	collapsed: boolean,
): Promise<void> {
	await setPref(REVIEW_LEFT_PANE_COLLAPSED_KEY, collapsed);
}

export async function getRightPaneCollapsed(): Promise<boolean> {
	return (await getPref<boolean>(RIGHT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setRightPaneCollapsed(collapsed: boolean): Promise<void> {
	await setPref(RIGHT_PANE_COLLAPSED_KEY, collapsed);
}

const OPEN_REPO_KEY = "open_repo";

export async function getOpenRepo(): Promise<RecentRepo | null> {
	return (await getPref<RecentRepo>(OPEN_REPO_KEY)) ?? null;
}

export async function setOpenRepo(repo: RecentRepo | null): Promise<void> {
	await setPref(OPEN_REPO_KEY, repo);
}

export type { ColumnWidths };

const LEGACY_COLUMN_WIDTHS_KEY = "column_widths";
const LEGACY_RESIZED_COLUMNS_KEY = "resized_columns";
const LEGACY_USER_WIDTHS_COPIED_KEY = "column_user_widths_copied";

/**
 * The user widths stored for every repository at once, before they were kept
 * per repository: each column named in `resized_columns` at its number in
 * `column_widths`, which also held fits.
 */
async function legacyUserWidths(): Promise<Partial<ColumnWidths>> {
	const widths = sanitizeLegacyColumnWidths(
		await getPref<unknown>(LEGACY_COLUMN_WIDTHS_KEY),
	);
	const resized = await getPref<unknown>(LEGACY_RESIZED_COLUMNS_KEY);
	if (!Array.isArray(resized)) return {};

	const userWidths: Partial<ColumnWidths> = {};
	for (const column of resized.filter(isSizedColumn)) {
		userWidths[column] = widths[column];
	}

	return userWidths;
}

/** Each string at `field` in a stored list of records; anything else is skipped. */
function storedPaths(list: unknown, field: "path" | "repoPath"): string[] {
	if (!Array.isArray(list)) return [];

	return list.flatMap((entry: unknown) => {
		if (typeof entry !== "object" || entry === null) return [];
		const path = (entry as Record<string, unknown>)[field];
		return typeof path === "string" ? [path] : [];
	});
}

async function knownRepositoryPaths(): Promise<Set<string>> {
	const recent = storedPaths(await getPref<unknown>(RECENT_KEY), "path");
	const open = storedPaths(await getPref<unknown>(TABS_KEY), "repoPath");

	return new Set([...recent, ...open]);
}

let columnLayoutQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs column layout reads and writes one at a time, in the order they were
 * asked for. Pref writes run concurrently on the Rust side, so two saves made a
 * moment apart, a drag's and then a double-click's, could land in either order
 * and bring back the width the double-click handed back; and a graph remounting
 * right after a drag must read the width that drag saved.
 */
function inColumnLayoutOrder<T>(work: () => Promise<T>): Promise<T> {
	const done = columnLayoutQueue.then(work);
	columnLayoutQueue = done.catch(() => {});

	return done;
}

function userWidthsKey(repoPath: string): string {
	return `column_user_widths:${repoPath}`;
}

/**
 * Gives each repository in the recent list or open in a tab, whose own entry is
 * missing or not a record of widths, the widths stored for every repository
 * before they were kept per repository, and never runs again once it has
 * finished. Called at launch, before any graph can load, so every load queues
 * behind it; a repository opened later fits its columns. The old keys stay in the
 * file, so an older build still finds them.
 */
export function copyLegacyUserWidthsOnce(): Promise<void> {
	return inColumnLayoutOrder(async () => {
		if ((await getPref<unknown>(LEGACY_USER_WIDTHS_COPIED_KEY)) === true)
			return;

		const widths = await legacyUserWidths();
		if (Object.keys(widths).length > 0) {
			for (const path of await knownRepositoryPaths()) {
				const own = await getPref<unknown>(userWidthsKey(path));
				if (isUserWidthsRecord(own)) continue;
				await setPref(userWidthsKey(path), widths);
			}
		}

		await setPref(LEGACY_USER_WIDTHS_COPIED_KEY, true);
	});
}

/**
 * The widths the user set in this repository, by column; every column missing
 * from it fits its content.
 */
export function loadUserWidths(
	repoPath: string,
	floors: ColumnFloors,
): Promise<Partial<ColumnWidths>> {
	return inColumnLayoutOrder(async () => {
		const stored = await getPref<unknown>(userWidthsKey(repoPath));

		return sanitizeUserWidths(stored, floors) ?? {};
	});
}

/** Replaces this repository's user widths, leaving every other repository's alone. */
export function saveUserWidths(
	repoPath: string,
	widths: Partial<ColumnWidths>,
): Promise<void> {
	const snapshot = { ...widths };

	return inColumnLayoutOrder(() => setPref(userWidthsKey(repoPath), snapshot));
}

export interface ColumnVisibility {
	ref: boolean;
	graph: boolean;
	message: boolean;
	diff: boolean;
	author: boolean;
	date: boolean;
	sha: boolean;
}

const COLUMN_VISIBILITY_KEY = "column_visibility";

const DEFAULT_VISIBILITY: ColumnVisibility = {
	ref: true,
	graph: true,
	message: true,
	diff: true,
	author: true,
	date: true,
	sha: true,
};

export async function getColumnVisibility(): Promise<ColumnVisibility> {
	// Spread-merge so a key added after a user first persisted their visibility
	// (e.g. `diff`) defaults to visible instead of arriving as undefined → falsy.
	// Message is forced on: its menu item is disabled, so a stored `false` would
	// hide the commit subjects with no control left to show them again.
	return {
		...DEFAULT_VISIBILITY,
		...(await getPref<ColumnVisibility>(COLUMN_VISIBILITY_KEY)),
		message: true,
	};
}

export async function setColumnVisibility(
	visibility: ColumnVisibility,
): Promise<void> {
	await setPref(COLUMN_VISIBILITY_KEY, visibility);
}

const sharedColumnVisibility = sharedPreference({
	defaultValue: DEFAULT_VISIBILITY,
	read: getColumnVisibility,
	write: setColumnVisibility,
});

export const columnVisibilityPreference = sharedColumnVisibility.store;

export function changeColumnVisibility(
	column: Exclude<keyof ColumnVisibility, "message">,
	visible: boolean,
): Promise<void> {
	return sharedColumnVisibility.update((value) => ({
		...value,
		[column]: visible,
	}));
}

// Rebase editor column widths
export interface RebaseColumnWidths {
	sha: number;
	author: number;
	date: number;
	// action is fixed 90px, message is flex-1
}

const REBASE_COLUMN_WIDTHS_KEY = "rebase_column_widths";

const DEFAULT_REBASE_WIDTHS: RebaseColumnWidths = {
	sha: 80,
	author: 120,
	date: 100,
};

export async function getRebaseColumnWidths(): Promise<RebaseColumnWidths> {
	return (
		(await getPref<RebaseColumnWidths>(REBASE_COLUMN_WIDTHS_KEY)) ??
		DEFAULT_REBASE_WIDTHS
	);
}

export async function setRebaseColumnWidths(
	widths: RebaseColumnWidths,
): Promise<void> {
	await setPref(REBASE_COLUMN_WIDTHS_KEY, widths);
}

// Rebase editor column visibility
export interface RebaseColumnVisibility {
	sha: boolean;
	author: boolean;
	date: boolean;
	// action and message always visible
}

const REBASE_COLUMN_VISIBILITY_KEY = "rebase_column_visibility";

const DEFAULT_REBASE_VISIBILITY: RebaseColumnVisibility = {
	sha: true,
	author: true,
	date: true,
};

export async function getRebaseColumnVisibility(): Promise<RebaseColumnVisibility> {
	return (
		(await getPref<RebaseColumnVisibility>(REBASE_COLUMN_VISIBILITY_KEY)) ??
		DEFAULT_REBASE_VISIBILITY
	);
}

export async function setRebaseColumnVisibility(
	visibility: RebaseColumnVisibility,
): Promise<void> {
	await setPref(REBASE_COLUMN_VISIBILITY_KEY, visibility);
}

// Tab persistence
const ACTIVE_TAB_KEY = "active_tab_id";

export async function getOpenTabs(): Promise<PersistedTab[]> {
	return (await getPref<PersistedTab[]>(TABS_KEY)) ?? [];
}

export async function setOpenTabs(tabs: PersistedTab[]): Promise<void> {
	await setPref(TABS_KEY, tabs);
}

export async function getActiveTabId(): Promise<string | null> {
	return (await getPref<string>(ACTIVE_TAB_KEY)) ?? null;
}

export async function setActiveTabId(id: string): Promise<void> {
	await setPref(ACTIVE_TAB_KEY, id);
}

// Tree view preference
const TREE_VIEW_KEY = "tree_view_enabled";

export async function getTreeViewEnabled(): Promise<boolean> {
	return (await getPref<boolean>(TREE_VIEW_KEY)) ?? false;
}

export async function setTreeViewEnabled(enabled: boolean): Promise<void> {
	await setPref(TREE_VIEW_KEY, enabled);
}

const sharedTreeView = sharedPreference({
	defaultValue: false,
	read: getTreeViewEnabled,
	write: setTreeViewEnabled,
});

export const treeViewPreference = sharedTreeView.store;

export function changeTreeViewEnabled(enabled: boolean): Promise<void> {
	return sharedTreeView.update(() => enabled);
}

/**
 * All mounted views see edits immediately. Until a read succeeds, keep edits
 * as changes to replay over the saved value. A later edit or mount retries a
 * failed read, so a fallback displayed in the meantime never becomes the
 * basis for a write.
 */
function sharedPreference<T>({
	defaultValue,
	read,
	write,
}: {
	defaultValue: T;
	read: () => Promise<T>;
	write: (value: T) => Promise<void>;
}) {
	type Change = (value: T) => T;
	type Snapshot = { readonly value: T; readonly resolved: boolean };
	type ReadStatus = "loading" | "loaded" | "failed";
	let value = defaultValue;
	let status: ReadStatus = "loading";
	let mounted = false;
	let changes: Change[] = [];
	let restoring: Promise<void> | undefined;
	let writes: Promise<void> | undefined;
	const store = writable<Snapshot>(
		{ value: defaultValue, resolved: false },
		() => {
			mounted = true;
			if (!restoring) {
				publish(changes.length ? value : defaultValue, "loading");
			}
			void restore().catch(() => {});
			return () => {
				mounted = false;
			};
		},
	);

	function publish(next: T, nextStatus: ReadStatus): void {
		value = next;
		status = nextStatus;
		store.set({ value, resolved: status !== "loading" });
	}

	function enqueueWrite(next: T): Promise<void> {
		const done = (writes ?? Promise.resolve()).then(() => write(next));
		const settled = done
			.catch(() => {})
			.finally(() => {
				if (writes === settled) writes = undefined;
			});
		writes = settled;
		return done;
	}

	function restore(): Promise<void> {
		if (restoring) return restoring;
		const reading = writes ? writes.then(read) : read();
		restoring = reading.then(
			(saved) => {
				restoring = undefined;
				const restored = changes.reduce(
					(value, change) => change(value),
					saved,
				);
				const done = changes.length ? enqueueWrite(restored) : undefined;
				changes = [];
				publish(restored, "loaded");
				return done;
			},
			(error: unknown) => {
				restoring = undefined;
				publish(value, "failed");
				throw error;
			},
		);
		return restoring;
	}

	function update(change: Change): Promise<void> {
		if (!mounted) return Promise.resolve();
		const next = change(value);
		if (status !== "loaded") changes.push(change);
		const done = status === "loaded" ? enqueueWrite(next) : restore();
		publish(next, status);
		return done;
	}

	return {
		store: { subscribe: store.subscribe },
		update,
		settled: () => (changes.length ? restoring?.catch(() => {}) : writes),
	};
}

// Whether review threads are hidden. Which of them show is not kept, since
// the review panel opens on every thread. The key once held a single-state
// filter, which reads as shown. The legacy show_inline_comments key remains
// untouched on disk; it is deliberately not read or rewritten by this API.
const REVIEW_FILTER_KEY = "review_filter";

export async function getReviewThreadsHidden(): Promise<boolean> {
	return (await getPref<unknown>(REVIEW_FILTER_KEY)) === "none";
}

export async function setReviewThreadsHidden(hidden: boolean): Promise<void> {
	await setPref(REVIEW_FILTER_KEY, hidden ? "none" : "all");
}

// Diff display preferences (global, shared across tabs — per D-06)
const DIFF_CONTEXT_LINES_KEY = "diff_context_lines";
const DIFF_IGNORE_WHITESPACE_KEY = "diff_ignore_whitespace";

export async function getDiffContextLines(): Promise<number> {
	return (await getPref<number>(DIFF_CONTEXT_LINES_KEY)) ?? 3;
}

export async function setDiffContextLines(lines: number): Promise<void> {
	await setPref(DIFF_CONTEXT_LINES_KEY, lines);
}

export async function getDiffIgnoreWhitespace(): Promise<boolean> {
	return (await getPref<boolean>(DIFF_IGNORE_WHITESPACE_KEY)) ?? false;
}

export async function setDiffIgnoreWhitespace(ignore: boolean): Promise<void> {
	await setPref(DIFF_IGNORE_WHITESPACE_KEY, ignore);
}

const DIFF_VIEW_MODE_KEY = "diff_view_mode"; // legacy key for migration
const DIFF_CONTENT_MODE_KEY = "diff_content_mode";
const DIFF_LAYOUT_MODE_KEY = "diff_layout_mode";

export async function getDiffContentMode(): Promise<ContentMode> {
	const stored = await getPref<string>(DIFF_CONTENT_MODE_KEY);
	if (stored === "hunk" || stored === "full") return stored;
	// Migration from old ViewMode key
	const legacy = await getPref<string>(DIFF_VIEW_MODE_KEY);
	if (legacy === "full") return "full";
	return "hunk";
}

export async function setDiffContentMode(mode: ContentMode): Promise<void> {
	await setPref(DIFF_CONTENT_MODE_KEY, mode);
}

export async function getDiffLayoutMode(): Promise<LayoutMode> {
	const stored = await getPref<string>(DIFF_LAYOUT_MODE_KEY);
	if (stored === "inline" || stored === "split") return stored;
	// Migration from old ViewMode key
	const legacy = await getPref<string>(DIFF_VIEW_MODE_KEY);
	if (legacy === "split") return "split";
	return "inline";
}

export async function setDiffLayoutMode(mode: LayoutMode): Promise<void> {
	await setPref(DIFF_LAYOUT_MODE_KEY, mode);
}

// Source|Rendered toggle for markdown-file diffs. Global, defaults to "source"
// (grill §6): Rendered V1 has no change highlighting, so a rendered-by-default
// diff would hide the very changes the user opened it to see.
const DIFF_RENDER_MODE_KEY = "render_mode";

export async function getRenderMode(): Promise<RenderMode> {
	const stored = await getPref<string>(DIFF_RENDER_MODE_KEY);
	if (stored === "source" || stored === "rendered") return stored;
	return "source";
}

export async function setRenderMode(mode: RenderMode): Promise<void> {
	await setPref(DIFF_RENDER_MODE_KEY, mode);
}

const DIFF_SHOW_INVISIBLES_KEY = "diff_show_invisibles";

export async function getDiffShowInvisibles(): Promise<boolean> {
	return (await getPref<boolean>(DIFF_SHOW_INVISIBLES_KEY)) ?? false;
}

export async function setDiffShowInvisibles(show: boolean): Promise<void> {
	await setPref(DIFF_SHOW_INVISIBLES_KEY, show);
}

const DIFF_WORD_WRAP_KEY = "diff_word_wrap";

export async function getDiffWordWrap(): Promise<boolean> {
	return (await getPref<boolean>(DIFF_WORD_WRAP_KEY)) ?? false;
}

export async function setDiffWordWrap(wrap: boolean): Promise<void> {
	await setPref(DIFF_WORD_WRAP_KEY, wrap);
}

// Per-repo WIP commit draft (summary + description). Keyed by absolute repo
// path; empty drafts are deleted so the map stays bounded.
export interface CommitDraft {
	subject: string;
	body: string;
}

const COMMIT_DRAFTS_KEY = "commit_drafts";

let commitDraftQueue: Promise<unknown> = Promise.resolve();

function inCommitDraftOrder<T>(work: () => Promise<T>): Promise<T> {
	const done = commitDraftQueue.then(work);
	commitDraftQueue = done.catch(() => {});
	return done;
}

export function getCommitDraft(path: string): Promise<CommitDraft | null> {
	return inCommitDraftOrder(async () => {
		const drafts =
			(await getPref<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
		return drafts[path] ?? null;
	});
}

function writeCommitDraft(
	path: string,
	draft: CommitDraft | null,
	permit?: string,
): Promise<void> {
	return inCommitDraftOrder(async () => {
		const drafts =
			(await getPref<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY, permit)) ??
			{};
		if (draft === null && !(path in drafts)) return;
		const next = { ...drafts };
		if (draft === null) delete next[path];
		else next[path] = { ...draft };
		if (permit === undefined) await setPref(COMMIT_DRAFTS_KEY, next);
		else
			await safeInvoke("prefs_set", {
				key: COMMIT_DRAFTS_KEY,
				value: next,
				__updatePermit: permit,
			});
	});
}

export function setCommitDraft(
	path: string,
	draft: CommitDraft,
): Promise<void> {
	return writeCommitDraft(path, draft);
}

export function clearCommitDraft(path: string): Promise<void> {
	return writeCommitDraft(path, null);
}

export function flushCommitDraftForUpdate(
	path: string,
	draft: CommitDraft,
	permit: string,
): Promise<void> {
	return writeCommitDraft(
		path,
		draft.subject === "" && draft.body === "" ? null : draft,
		permit,
	);
}

// Periodic background fetch interval. 0 disables. Default 1 min.
const FETCH_INTERVAL_KEY = "fetch_interval_ms";
export const DEFAULT_FETCH_INTERVAL_MS = 60 * 1000;
const fetchIntervalSubscribers = new Set<(ms: number) => void>();

function validFetchInterval(ms: unknown): number {
	return typeof ms === "number" && Number.isFinite(ms)
		? Math.max(0, Math.floor(ms))
		: DEFAULT_FETCH_INTERVAL_MS;
}

export async function getFetchIntervalMs(): Promise<number> {
	return validFetchInterval(await getPref<number>(FETCH_INTERVAL_KEY));
}

export async function setFetchIntervalMs(ms: number): Promise<void> {
	const interval = validFetchInterval(ms);
	await setPref(FETCH_INTERVAL_KEY, interval);
	for (const subscriber of fetchIntervalSubscribers) subscriber(interval);
}

export function subscribeFetchInterval(
	subscriber: (ms: number) => void,
): () => void {
	fetchIntervalSubscribers.add(subscriber);
	return () => fetchIntervalSubscribers.delete(subscriber);
}

// Which refs each repository hides from its graph, keyed by absolute repo path like
// commit_drafts above. A repository absent from the map hides nothing.
const REF_VISIBILITY_KEY = "ref_visibility";
let refVisibilityQueue = Promise.resolve();
const refVisibilityWrites = new Map<string, Promise<void>>();

export async function refVisibilityWritesSettled(path: string): Promise<void> {
	await refVisibilityWrites.get(path);
}

export async function getRefVisibility(path: string): Promise<RefVisibility> {
	await refVisibilityWritesSettled(path);
	const all =
		(await getPref<Record<string, RefVisibility>>(REF_VISIBILITY_KEY)) ?? {};
	// Spread-merged over the default so a file written before a field existed still
	// parses, matching the Rust side's `#[serde(default)]`.
	const stored = all[path];
	return stored === undefined
		? EVERYTHING_VISIBLE
		: { ...EVERYTHING_VISIBLE, ...stored };
}

export function setRefVisibility(
	path: string,
	visibility: RefVisibility,
): Promise<void> {
	// A single preference holds every repository, so each whole read/write pair
	// must finish before another save reads it.
	const done = refVisibilityQueue.then(async () => {
		const all =
			(await getPref<Record<string, RefVisibility>>(REF_VISIBILITY_KEY)) ?? {};
		await setPref(REF_VISIBILITY_KEY, { ...all, [path]: visibility });
	});
	const settled = done.catch(() => {});
	refVisibilityQueue = settled;
	refVisibilityWrites.set(path, settled);
	void settled.then(() => {
		if (refVisibilityWrites.get(path) === settled)
			refVisibilityWrites.delete(path);
	});
	return done;
}

const reviewUpdateKey = (path: string) => `update_review_composer:${path}`;

export async function getReviewUpdateSnapshot(
	path: string,
): Promise<import("./review-editors.svelte.js").ReviewUpdateComposer | null> {
	return readReviewUpdateSnapshot(
		await getPref<unknown>(reviewUpdateKey(path)),
	);
}

export async function clearReviewUpdateSnapshot(
	path: string,
	permit?: string,
): Promise<void> {
	await safeInvoke("prefs_set", {
		key: reviewUpdateKey(path),
		value: null,
		...(permit === undefined ? {} : { __updatePermit: permit }),
	});
}

export async function flushReviewComposerForUpdate(
	path: string,
	composer: import("./review-editors.svelte.js").ReviewUpdateComposer | null,
	permit: string,
): Promise<void> {
	if (composer) {
		await safeInvoke("save_draft", {
			path,
			text: composer.text,
			anchor: composer.captured.anchor,
			wholeFile: composer.captured.wholeFile === true,
			__updatePermit: permit,
		});
	}
	await safeInvoke("prefs_set", {
		key: reviewUpdateKey(path),
		value: composer,
		__updatePermit: permit,
	});
}
