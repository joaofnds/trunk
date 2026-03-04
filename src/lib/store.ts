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
