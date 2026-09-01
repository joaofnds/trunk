import { safeInvoke } from "./invoke.js";
import type { PersistedTab } from "./tab-types.js";
import type { ContentMode, LayoutMode, RenderMode } from "./types.js";

export type { PersistedTab } from "./tab-types.js";

export interface RecentRepo {
	name: string;
	path: string;
}

// Prefs live in a Rust-side map backed by trunk-prefs.json; every set
// rewrites the file atomically in one prefs_set call.
async function getPref<T>(key: string): Promise<T | null> {
	return await safeInvoke<T | null>("prefs_get", { key });
}

async function setPref(key: string, value: unknown): Promise<void> {
	await safeInvoke("prefs_set", { key, value });
}

const RECENT_KEY = "recent_repos";

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

export async function getLeftPaneWidth(): Promise<number> {
	return (await getPref<number>(LEFT_PANE_KEY)) ?? 220;
}

export async function setLeftPaneWidth(width: number): Promise<void> {
	await setPref(LEFT_PANE_KEY, width);
}

export async function getRightPaneWidth(): Promise<number> {
	return (await getPref<number>(RIGHT_PANE_KEY)) ?? 240;
}

export async function setRightPaneWidth(width: number): Promise<void> {
	await setPref(RIGHT_PANE_KEY, width);
}

const LEFT_PANE_COLLAPSED_KEY = "left_pane_collapsed";
const RIGHT_PANE_COLLAPSED_KEY = "right_pane_collapsed";

export async function getLeftPaneCollapsed(): Promise<boolean> {
	return (await getPref<boolean>(LEFT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setLeftPaneCollapsed(collapsed: boolean): Promise<void> {
	await setPref(LEFT_PANE_COLLAPSED_KEY, collapsed);
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

export interface ColumnWidths {
	ref: number;
	graph: number;
	diff: number;
	author: number;
	date: number;
	sha: number;
	// message is flex-1, no fixed width
}

const COLUMN_WIDTHS_KEY = "column_widths";

const DEFAULT_WIDTHS: ColumnWidths = {
	ref: 120,
	graph: 24,
	diff: 96,
	author: 60,
	date: 40,
	sha: 50,
};

export async function getColumnWidths(): Promise<ColumnWidths> {
	// Spread-merge so a key added after a user first persisted their widths
	// (e.g. `diff`) picks up its default instead of arriving as undefined → NaN.
	return {
		...DEFAULT_WIDTHS,
		...(await getPref<ColumnWidths>(COLUMN_WIDTHS_KEY)),
	};
}

export async function setColumnWidths(widths: ColumnWidths): Promise<void> {
	await setPref(COLUMN_WIDTHS_KEY, widths);
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
	return {
		...DEFAULT_VISIBILITY,
		...(await getPref<ColumnVisibility>(COLUMN_VISIBILITY_KEY)),
	};
}

export async function setColumnVisibility(
	visibility: ColumnVisibility,
): Promise<void> {
	await setPref(COLUMN_VISIBILITY_KEY, visibility);
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
const TABS_KEY = "open_tabs";
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

// Review mode preference (gates inline comment cards + in-diff Comment buttons).
// Default off so diffs are clean/read-only until the user turns review on.
const SHOW_INLINE_COMMENTS_KEY = "show_inline_comments";

export async function getShowInlineComments(): Promise<boolean> {
	return (await getPref<boolean>(SHOW_INLINE_COMMENTS_KEY)) ?? false;
}

export async function setShowInlineComments(show: boolean): Promise<void> {
	await setPref(SHOW_INLINE_COMMENTS_KEY, show);
}

// Diff display preferences (global, shared across tabs — per D-06)
const DIFF_CONTEXT_LINES_KEY = "diff_context_lines";
const DIFF_IGNORE_WHITESPACE_KEY = "diff_ignore_whitespace";
const DIFF_SHOW_FULL_FILE_KEY = "diff_show_full_file";

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

export async function getDiffShowFullFile(): Promise<boolean> {
	return (await getPref<boolean>(DIFF_SHOW_FULL_FILE_KEY)) ?? false;
}

export async function setDiffShowFullFile(show: boolean): Promise<void> {
	await setPref(DIFF_SHOW_FULL_FILE_KEY, show);
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

export async function getCommitDraft(
	path: string,
): Promise<CommitDraft | null> {
	const drafts =
		(await getPref<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	return drafts[path] ?? null;
}

export async function setCommitDraft(
	path: string,
	draft: CommitDraft,
): Promise<void> {
	const drafts =
		(await getPref<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	await setPref(COMMIT_DRAFTS_KEY, { ...drafts, [path]: draft });
}

export async function clearCommitDraft(path: string): Promise<void> {
	const drafts =
		(await getPref<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	if (!(path in drafts)) return;
	const { [path]: _removed, ...rest } = drafts;
	await setPref(COMMIT_DRAFTS_KEY, rest);
}

// Periodic background fetch interval. 0 disables. Default 5 min.
const FETCH_INTERVAL_KEY = "fetch_interval_ms";
const DEFAULT_FETCH_INTERVAL_MS = 60 * 1000;

export async function getFetchIntervalMs(): Promise<number> {
	return (
		(await getPref<number>(FETCH_INTERVAL_KEY)) ?? DEFAULT_FETCH_INTERVAL_MS
	);
}

export async function setFetchIntervalMs(ms: number): Promise<void> {
	await setPref(FETCH_INTERVAL_KEY, ms);
}
