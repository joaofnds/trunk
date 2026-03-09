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
