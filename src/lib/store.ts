import { LazyStore } from "@tauri-apps/plugin-store";
import type { PersistedTab } from "./tab-types.js";
import type { ContentMode, LayoutMode } from "./types.js";

export type { PersistedTab } from "./tab-types.js";

export interface RecentRepo {
	name: string;
	path: string;
}

const store = new LazyStore("trunk-prefs.json");
const RECENT_KEY = "recent_repos";

export async function addRecentRepo(repo: RecentRepo): Promise<void> {
	const current = (await store.get<RecentRepo[]>(RECENT_KEY)) ?? [];
	const updated = [repo, ...current.filter((r) => r.path !== repo.path)];
	await store.set(RECENT_KEY, updated);
	await store.save();
}

export async function getRecentRepos(): Promise<RecentRepo[]> {
	return (await store.get<RecentRepo[]>(RECENT_KEY)) ?? [];
}

export async function removeRecentRepo(path: string): Promise<void> {
	const current = (await store.get<RecentRepo[]>(RECENT_KEY)) ?? [];
	const updated = current.filter((r) => r.path !== path);
	await store.set(RECENT_KEY, updated);
	await store.save();
}

const ZOOM_KEY = "zoom_level";

export async function getZoomLevel(): Promise<number> {
	return (await store.get<number>(ZOOM_KEY)) ?? 1;
}

export async function setZoomLevel(level: number): Promise<void> {
	await store.set(ZOOM_KEY, level);
	await store.save();
}

const LEFT_PANE_KEY = "left_pane_width";
const RIGHT_PANE_KEY = "right_pane_width";

export async function getLeftPaneWidth(): Promise<number> {
	return (await store.get<number>(LEFT_PANE_KEY)) ?? 220;
}

export async function setLeftPaneWidth(width: number): Promise<void> {
	await store.set(LEFT_PANE_KEY, width);
	await store.save();
}

export async function getRightPaneWidth(): Promise<number> {
	return (await store.get<number>(RIGHT_PANE_KEY)) ?? 240;
}

export async function setRightPaneWidth(width: number): Promise<void> {
	await store.set(RIGHT_PANE_KEY, width);
	await store.save();
}

const LEFT_PANE_COLLAPSED_KEY = "left_pane_collapsed";
const RIGHT_PANE_COLLAPSED_KEY = "right_pane_collapsed";

export async function getLeftPaneCollapsed(): Promise<boolean> {
	return (await store.get<boolean>(LEFT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setLeftPaneCollapsed(collapsed: boolean): Promise<void> {
	await store.set(LEFT_PANE_COLLAPSED_KEY, collapsed);
	await store.save();
}

export async function getRightPaneCollapsed(): Promise<boolean> {
	return (await store.get<boolean>(RIGHT_PANE_COLLAPSED_KEY)) ?? false;
}

export async function setRightPaneCollapsed(collapsed: boolean): Promise<void> {
	await store.set(RIGHT_PANE_COLLAPSED_KEY, collapsed);
	await store.save();
}

const OPEN_REPO_KEY = "open_repo";

export async function getOpenRepo(): Promise<RecentRepo | null> {
	return (await store.get<RecentRepo>(OPEN_REPO_KEY)) ?? null;
}

export async function setOpenRepo(repo: RecentRepo | null): Promise<void> {
	await store.set(OPEN_REPO_KEY, repo);
	await store.save();
}

export interface ColumnWidths {
	ref: number;
	graph: number;
	author: number;
	date: number;
	sha: number;
	// message is flex-1, no fixed width
}

const COLUMN_WIDTHS_KEY = "column_widths";

const DEFAULT_WIDTHS: ColumnWidths = {
	ref: 120,
	graph: 24,
	author: 60,
	date: 40,
	sha: 50,
};

export async function getColumnWidths(): Promise<ColumnWidths> {
	return (await store.get<ColumnWidths>(COLUMN_WIDTHS_KEY)) ?? DEFAULT_WIDTHS;
}

export async function setColumnWidths(widths: ColumnWidths): Promise<void> {
	await store.set(COLUMN_WIDTHS_KEY, widths);
	await store.save();
}

export interface ColumnVisibility {
	ref: boolean;
	graph: boolean;
	message: boolean;
	author: boolean;
	date: boolean;
	sha: boolean;
}

const COLUMN_VISIBILITY_KEY = "column_visibility";

const DEFAULT_VISIBILITY: ColumnVisibility = {
	ref: true,
	graph: true,
	message: true,
	author: true,
	date: true,
	sha: true,
};

export async function getColumnVisibility(): Promise<ColumnVisibility> {
	return (
		(await store.get<ColumnVisibility>(COLUMN_VISIBILITY_KEY)) ??
		DEFAULT_VISIBILITY
	);
}

export async function setColumnVisibility(
	visibility: ColumnVisibility,
): Promise<void> {
	await store.set(COLUMN_VISIBILITY_KEY, visibility);
	await store.save();
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
		(await store.get<RebaseColumnWidths>(REBASE_COLUMN_WIDTHS_KEY)) ??
		DEFAULT_REBASE_WIDTHS
	);
}

export async function setRebaseColumnWidths(
	widths: RebaseColumnWidths,
): Promise<void> {
	await store.set(REBASE_COLUMN_WIDTHS_KEY, widths);
	await store.save();
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
		(await store.get<RebaseColumnVisibility>(REBASE_COLUMN_VISIBILITY_KEY)) ??
		DEFAULT_REBASE_VISIBILITY
	);
}

export async function setRebaseColumnVisibility(
	visibility: RebaseColumnVisibility,
): Promise<void> {
	await store.set(REBASE_COLUMN_VISIBILITY_KEY, visibility);
	await store.save();
}

// Tab persistence
const TABS_KEY = "open_tabs";
const ACTIVE_TAB_KEY = "active_tab_id";

export async function getOpenTabs(): Promise<PersistedTab[]> {
	return (await store.get<PersistedTab[]>(TABS_KEY)) ?? [];
}

export async function setOpenTabs(tabs: PersistedTab[]): Promise<void> {
	await store.set(TABS_KEY, tabs);
	await store.save();
}

export async function getActiveTabId(): Promise<string | null> {
	return (await store.get<string>(ACTIVE_TAB_KEY)) ?? null;
}

export async function setActiveTabId(id: string): Promise<void> {
	await store.set(ACTIVE_TAB_KEY, id);
	await store.save();
}

// Tree view preference
const TREE_VIEW_KEY = "tree_view_enabled";

export async function getTreeViewEnabled(): Promise<boolean> {
	return (await store.get<boolean>(TREE_VIEW_KEY)) ?? false;
}

export async function setTreeViewEnabled(enabled: boolean): Promise<void> {
	await store.set(TREE_VIEW_KEY, enabled);
	await store.save();
}

// Review mode preference (gates inline comment cards + in-diff Comment buttons).
// Default off so diffs are clean/read-only until the user turns review on.
const SHOW_INLINE_COMMENTS_KEY = "show_inline_comments";

export async function getShowInlineComments(): Promise<boolean> {
	return (await store.get<boolean>(SHOW_INLINE_COMMENTS_KEY)) ?? false;
}

export async function setShowInlineComments(show: boolean): Promise<void> {
	await store.set(SHOW_INLINE_COMMENTS_KEY, show);
	await store.save();
}

// Diff display preferences (global, shared across tabs — per D-06)
const DIFF_CONTEXT_LINES_KEY = "diff_context_lines";
const DIFF_IGNORE_WHITESPACE_KEY = "diff_ignore_whitespace";
const DIFF_SHOW_FULL_FILE_KEY = "diff_show_full_file";

export async function getDiffContextLines(): Promise<number> {
	return (await store.get<number>(DIFF_CONTEXT_LINES_KEY)) ?? 3;
}

export async function setDiffContextLines(lines: number): Promise<void> {
	await store.set(DIFF_CONTEXT_LINES_KEY, lines);
	await store.save();
}

export async function getDiffIgnoreWhitespace(): Promise<boolean> {
	return (await store.get<boolean>(DIFF_IGNORE_WHITESPACE_KEY)) ?? false;
}

export async function setDiffIgnoreWhitespace(ignore: boolean): Promise<void> {
	await store.set(DIFF_IGNORE_WHITESPACE_KEY, ignore);
	await store.save();
}

export async function getDiffShowFullFile(): Promise<boolean> {
	return (await store.get<boolean>(DIFF_SHOW_FULL_FILE_KEY)) ?? false;
}

export async function setDiffShowFullFile(show: boolean): Promise<void> {
	await store.set(DIFF_SHOW_FULL_FILE_KEY, show);
	await store.save();
}

const DIFF_VIEW_MODE_KEY = "diff_view_mode"; // legacy key for migration
const DIFF_CONTENT_MODE_KEY = "diff_content_mode";
const DIFF_LAYOUT_MODE_KEY = "diff_layout_mode";

export async function getDiffContentMode(): Promise<ContentMode> {
	const stored = await store.get<string>(DIFF_CONTENT_MODE_KEY);
	if (stored === "hunk" || stored === "full") return stored;
	// Migration from old ViewMode key
	const legacy = await store.get<string>(DIFF_VIEW_MODE_KEY);
	if (legacy === "full") return "full";
	return "hunk";
}

export async function setDiffContentMode(mode: ContentMode): Promise<void> {
	await store.set(DIFF_CONTENT_MODE_KEY, mode);
	await store.save();
}

export async function getDiffLayoutMode(): Promise<LayoutMode> {
	const stored = await store.get<string>(DIFF_LAYOUT_MODE_KEY);
	if (stored === "inline" || stored === "split") return stored;
	// Migration from old ViewMode key
	const legacy = await store.get<string>(DIFF_VIEW_MODE_KEY);
	if (legacy === "split") return "split";
	return "inline";
}

export async function setDiffLayoutMode(mode: LayoutMode): Promise<void> {
	await store.set(DIFF_LAYOUT_MODE_KEY, mode);
	await store.save();
}

const DIFF_SHOW_INVISIBLES_KEY = "diff_show_invisibles";

export async function getDiffShowInvisibles(): Promise<boolean> {
	return (await store.get<boolean>(DIFF_SHOW_INVISIBLES_KEY)) ?? false;
}

export async function setDiffShowInvisibles(show: boolean): Promise<void> {
	await store.set(DIFF_SHOW_INVISIBLES_KEY, show);
	await store.save();
}

const DIFF_WORD_WRAP_KEY = "diff_word_wrap";

export async function getDiffWordWrap(): Promise<boolean> {
	return (await store.get<boolean>(DIFF_WORD_WRAP_KEY)) ?? false;
}

export async function setDiffWordWrap(wrap: boolean): Promise<void> {
	await store.set(DIFF_WORD_WRAP_KEY, wrap);
	await store.save();
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
		(await store.get<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	return drafts[path] ?? null;
}

export async function setCommitDraft(
	path: string,
	draft: CommitDraft,
): Promise<void> {
	const drafts =
		(await store.get<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	await store.set(COMMIT_DRAFTS_KEY, { ...drafts, [path]: draft });
	await store.save();
}

export async function clearCommitDraft(path: string): Promise<void> {
	const drafts =
		(await store.get<Record<string, CommitDraft>>(COMMIT_DRAFTS_KEY)) ?? {};
	if (!(path in drafts)) return;
	const { [path]: _removed, ...rest } = drafts;
	await store.set(COMMIT_DRAFTS_KEY, rest);
	await store.save();
}

// Periodic background fetch interval. 0 disables. Default 5 min.
const FETCH_INTERVAL_KEY = "fetch_interval_ms";
const DEFAULT_FETCH_INTERVAL_MS = 60 * 1000;

export async function getFetchIntervalMs(): Promise<number> {
	return (
		(await store.get<number>(FETCH_INTERVAL_KEY)) ?? DEFAULT_FETCH_INTERVAL_MS
	);
}

export async function setFetchIntervalMs(ms: number): Promise<void> {
	await store.set(FETCH_INTERVAL_KEY, ms);
	await store.save();
}
