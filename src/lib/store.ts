import { LazyStore } from '@tauri-apps/plugin-store';

export interface RecentRepo { name: string; path: string; }

const store = new LazyStore('trunk-prefs.json');
const RECENT_KEY = 'recent_repos';
const MAX_RECENT = 5;

export async function addRecentRepo(repo: RecentRepo): Promise<void> {
  const current = await store.get<RecentRepo[]>(RECENT_KEY) ?? [];
  const updated = [repo, ...current.filter(r => r.path !== repo.path)].slice(0, MAX_RECENT);
  await store.set(RECENT_KEY, updated);
  await store.save();
}

export async function getRecentRepos(): Promise<RecentRepo[]> {
  return await store.get<RecentRepo[]>(RECENT_KEY) ?? [];
}

export async function removeRecentRepo(path: string): Promise<void> {
  const current = await store.get<RecentRepo[]>(RECENT_KEY) ?? [];
  const updated = current.filter(r => r.path !== path);
  await store.set(RECENT_KEY, updated);
  await store.save();
}

const ZOOM_KEY = 'zoom_level';

export async function getZoomLevel(): Promise<number> {
  return (await store.get<number>(ZOOM_KEY)) ?? 1;
}

export async function setZoomLevel(level: number): Promise<void> {
  await store.set(ZOOM_KEY, level);
  await store.save();
}

const LEFT_PANE_KEY = 'left_pane_width';
const RIGHT_PANE_KEY = 'right_pane_width';

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

const LEFT_PANE_COLLAPSED_KEY = 'left_pane_collapsed';
const RIGHT_PANE_COLLAPSED_KEY = 'right_pane_collapsed';

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

const OPEN_REPO_KEY = 'open_repo';

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

const COLUMN_WIDTHS_KEY = 'column_widths';

const DEFAULT_WIDTHS: ColumnWidths = {
  ref: 120,
  graph: 120,
  author: 120,
  date: 100,
  sha: 80,
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

const COLUMN_VISIBILITY_KEY = 'column_visibility';

const DEFAULT_VISIBILITY: ColumnVisibility = {
  ref: true,
  graph: true,
  message: true,
  author: true,
  date: true,
  sha: true,
};

export async function getColumnVisibility(): Promise<ColumnVisibility> {
  return (await store.get<ColumnVisibility>(COLUMN_VISIBILITY_KEY)) ?? DEFAULT_VISIBILITY;
}

export async function setColumnVisibility(visibility: ColumnVisibility): Promise<void> {
  await store.set(COLUMN_VISIBILITY_KEY, visibility);
  await store.save();
}
