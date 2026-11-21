import { SvelteMap } from "svelte/reactivity";
import type { Scheduler } from "./scheduler.js";
import type { PersistedTab } from "./tab-types.js";

type RepositoryTab = Pick<PersistedTab, "id" | "repoPath">;
type OpenRepositoryTab = RepositoryTab & { repoPath: string };

export function repositoryPathKey(path: string): string;
export function repositoryPathKey(path: string | null): string | null;
export function repositoryPathKey(path: string | null): string | null {
	return path?.replace(/\/+$/, "") ?? null;
}

class RepositorySession {
	ready = $state(false);
	visited = $state(false);
	viewReady = false;
	preparation?: Promise<void>;

	readonly id: string;
	readonly path: string;

	constructor({ id, repoPath }: OpenRepositoryTab) {
		this.id = id;
		this.path = repoPath;
	}
}

interface RepositoryLifecycle {
	open(path: string): Promise<void>;
	close(path: string): Promise<void>;
	loadUnvisitedBadge(tab: OpenRepositoryTab): Promise<void>;
	failed(tab: OpenRepositoryTab, error: unknown): void;
}

interface OpeningRepository {
	readonly path: string;
	readonly ready: Promise<void>;
	users: number;
}

/** Restore the foreground first; prepare other backends without mounting their views. */
export class RepositoryTabs {
	private readonly sessions = new SvelteMap<string, RepositorySession>();
	private readonly requestedOpens = new Map<string, OpeningRepository>();
	private activeId = "";
	private backgroundRunning = false;
	private opening?: RepositorySession;
	private timer?: number;
	private disposed = false;

	constructor(
		private readonly scheduler: Scheduler,
		private readonly lifecycle: RepositoryLifecycle,
	) {}

	restore(tabs: readonly RepositoryTab[]): void {
		for (const tab of tabs) {
			if (tab.repoPath)
				this.sessions.set(
					tab.id,
					new RepositorySession({ id: tab.id, repoPath: tab.repoPath }),
				);
		}
	}

	/** The welcome screen and picker have already opened this repository. */
	opened(tab: OpenRepositoryTab): void {
		const current = this.sessions.get(tab.id);
		if (current?.path === tab.repoPath) {
			current.ready = true;
			return;
		}
		const session = new RepositorySession(tab);
		session.ready = true;
		this.sessions.set(tab.id, session);
	}

	/** Share a backend until all choices for it have had a chance to attach a tab. */
	async openForTab(
		path: string,
		attach: (openedPath: string) => void,
	): Promise<void> {
		const key = repositoryPathKey(path);
		let opening = this.requestedOpens.get(key);
		if (!opening) {
			opening = { path, ready: this.lifecycle.open(path), users: 0 };
			this.requestedOpens.set(key, opening);
		}
		opening.users += 1;
		let ready = false;
		try {
			await opening.ready;
			ready = true;
			attach(opening.path);
		} finally {
			opening.users -= 1;
			if (opening.users === 0) {
				this.requestedOpens.delete(key);
				if (ready) void this.closeUnused(opening.path);
			}
		}
	}

	async closeUnused(path: string): Promise<void> {
		if (this.requestedOpens.get(repositoryPathKey(path))?.path === path) return;
		await this.lifecycle.close(path);
	}

	update(tabs: readonly RepositoryTab[], activeId: string): void {
		for (const [id, session] of this.sessions) {
			if (!tabs.some((tab) => tab.id === id && tab.repoPath === session.path))
				this.sessions.delete(id);
		}
		this.activeId = activeId;
		const active = this.sessions.get(activeId);
		if (active) {
			if (active.ready) active.visited = true;
			void this.prepare(active);
		}
		this.armBackground();
	}

	isReady(tab: RepositoryTab): boolean {
		const session = this.sessions.get(tab.id);
		return !!session && session.path === tab.repoPath && session.ready;
	}

	wasVisited(tab: RepositoryTab): boolean {
		const session = this.sessions.get(tab.id);
		return (
			!!session &&
			session.path === tab.repoPath &&
			session.ready &&
			session.visited
		);
	}

	viewReady(tab: RepositoryTab): void {
		const session = this.sessions.get(tab.id);
		if (!session || session.path !== tab.repoPath) return;

		session.viewReady = true;
		this.armBackground();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
	}

	private async prepare(session: RepositorySession): Promise<void> {
		if (session.ready || this.disposed) return;
		if (session.preparation) return session.preparation;
		if (this.opening) return;
		this.opening = session;
		session.preparation = (async () => {
			try {
				await this.openSession(session);
				if (!session.ready || this.sessions.get(session.id) !== session) return;
				this.releaseOpen(session);
				if (!session.visited)
					await this.lifecycle.loadUnvisitedBadge({
						id: session.id,
						repoPath: session.path,
					});
			} finally {
				this.releaseOpen(session);
			}
		})();
		return session.preparation;
	}

	private async openSession(session: RepositorySession): Promise<void> {
		const isCurrent = () =>
			!this.disposed && this.sessions.get(session.id) === session;
		try {
			await this.openForTab(session.path, () => {
				if (!isCurrent()) return;
				session.ready = true;
				if (session.id === this.activeId) session.visited = true;
			});
		} catch (error) {
			if (isCurrent()) {
				this.sessions.delete(session.id);
				this.lifecycle.failed(
					{ id: session.id, repoPath: session.path },
					error,
				);
			}
		}
	}

	private releaseOpen(session: RepositorySession): void {
		if (this.opening !== session) return;
		this.opening = undefined;
		const active = this.sessions.get(this.activeId);
		if (active && !active.ready) void this.prepare(active);
		else this.armBackground();
	}

	private armBackground(): void {
		if (
			this.disposed ||
			this.opening ||
			this.backgroundRunning ||
			this.timer !== undefined
		)
			return;
		const active = this.sessions.get(this.activeId);
		if (active && !active.viewReady) return;
		if (
			![...this.sessions.values()].some(
				(session) => !session.ready && !session.preparation,
			)
		)
			return;
		// Yield after the foreground render and between repositories.
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = undefined;
			void this.prepareNext();
		}, 0);
	}

	private async prepareNext(): Promise<void> {
		const active = this.sessions.get(this.activeId);
		if (this.disposed || (active && !active.viewReady)) return;
		const next = [...this.sessions.values()].find(
			(session) => !session.ready && !session.preparation,
		);
		if (!next) return;
		this.backgroundRunning = true;
		try {
			await this.prepare(next);
		} finally {
			this.backgroundRunning = false;
			this.armBackground();
		}
	}
}
