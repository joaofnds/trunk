import type { Scheduler } from "./scheduler.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface Entry {
	due: number;
}

interface OpenRepositories {
	paths: readonly string[];
	activePath: string | null;
	focused: boolean;
	manualBusy: boolean;
}

/** One completion-based queue for every open repository. The backend additionally
 *  owns the execution permit; this queue controls cadence and tab fairness. */
export class AutofetchScheduler {
	private readonly entries = new Map<string, Entry>();
	private interval = 0;
	private timer: number | undefined;
	private running = false;
	private disposed = false;
	private activePath: string | null = null;
	private focused = false;
	private manualBusy = false;

	constructor(
		private readonly scheduler: Scheduler,
		private readonly fetch: (path: string, intervalMs: number) => Promise<void>,
	) {}

	setInterval(interval: number): void {
		if (interval === this.interval) return;

		this.interval = interval;
		const started = this.scheduler.currentTimeMs();
		let index = 0;
		for (const entry of this.entries.values()) {
			entry.due = started + (++index * interval) / this.entries.size;
		}

		this.arm();
	}

	update(repositories: OpenRepositories): void {
		const paths = new Set(repositories.paths);
		for (const path of this.entries.keys()) {
			if (!paths.has(path)) this.entries.delete(path);
		}
		const added = [...paths].filter((path) => !this.entries.has(path));
		const started = this.scheduler.currentTimeMs();
		for (const [index, path] of added.entries()) {
			this.entries.set(path, {
				due: started + ((index + 1) * this.interval) / added.length,
			});
		}
		this.activePath = repositories.activePath;
		this.focused = repositories.focused;
		this.manualBusy = repositories.manualBusy;
		this.arm();
	}

	/** A successful manual all-remotes fetch already performed this check. */
	checked(path: string): void {
		const entry = this.entries.get(path);
		if (entry) entry.due = this.scheduler.currentTimeMs() + this.interval;
		this.arm();
	}

	dispose(): void {
		this.disposed = true;
		this.entries.clear();
		this.disarm();
	}

	private disarm(): void {
		if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(): void {
		this.disarm();
		if (
			this.disposed ||
			this.running ||
			!this.focused ||
			this.manualBusy ||
			this.interval <= 0 ||
			this.entries.size === 0
		)
			return;
		const due = Math.min(
			...[...this.entries.values()].map((entry) => entry.due),
		);
		this.timer = this.scheduler.setTimeout(
			() => {
				this.timer = undefined;
				void this.run();
			},
			Math.min(
				MAX_TIMER_DELAY_MS,
				Math.max(0, due - this.scheduler.currentTimeMs()),
			),
		);
	}

	private async run(): Promise<void> {
		if (this.disposed || this.running || !this.focused || this.manualBusy)
			return;
		const now = this.scheduler.currentTimeMs();
		const overdue = [...this.entries.entries()]
			.filter(([, entry]) => entry.due <= now)
			.sort((left, right) => left[1].due - right[1].due);
		const oldest = overdue[0];
		if (!oldest) {
			this.arm();
			return;
		}
		// The active tab may go first for one interval. An older overdue tab then
		// wins, so repeated activation cannot indefinitely postpone its check.
		const preferred =
			now - oldest[1].due < this.interval
				? overdue.find(([path]) => path === this.activePath)
				: undefined;
		const [path, entry] = preferred ?? oldest;
		this.running = true;
		try {
			await this.fetch(path, this.interval);
		} catch {
			// The adapter records errors quietly. IPC failure still releases the queue.
		} finally {
			if (this.entries.get(path) === entry)
				entry.due = this.scheduler.currentTimeMs() + this.interval;
			this.running = false;
			this.arm();
		}
	}
}
