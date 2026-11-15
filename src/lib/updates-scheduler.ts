import type { OwnedTimer } from "./owned-timer.js";

const REGULAR_INTERVAL = 4 * 60 * 60_000;
const RETRY_BUDGET = 3;

/** One owned timer serves independent regular and bounded retry deadlines. */
export class UpdateCheckScheduler {
	private enabled = false;
	private pausedAt: number | null = null;
	private regularAt = 0;
	private retryAt: number | null = null;
	private retries = 0;
	private running = false;
	private epoch = 0;

	constructor(
		private readonly timer: OwnedTimer,
		private readonly now: () => number,
		private readonly random: () => number,
		private readonly check: () => Promise<void>,
	) {}

	update(enabled: boolean, paused: boolean): void {
		if (enabled !== this.enabled) {
			this.enabled = enabled;
			this.epoch += 1;
			this.retries = 0;
			this.retryAt = null;
			this.regularAt = this.now() + 15_000;
			this.pausedAt = null;
		}
		if (paused && this.pausedAt === null) this.pausedAt = this.now();
		if (!paused && this.pausedAt !== null) {
			const elapsed = this.now() - this.pausedAt;
			this.regularAt += elapsed;
			if (this.retryAt !== null) this.retryAt += elapsed;
			this.pausedAt = null;
		}
		this.arm();
	}

	/** Explicit user actions begin a fresh retry budget. */
	reset(): void {
		this.epoch += 1;
		this.retries = 0;
		this.retryAt = null;
		this.regularAt = (this.pausedAt ?? this.now()) + REGULAR_INTERVAL;
		this.arm();
	}

	private arm(): void {
		this.timer.cancel();
		if (!this.enabled || this.pausedAt !== null || this.running) return;
		const next = Math.min(this.regularAt, this.retryAt ?? Infinity);
		this.timer.arm(() => void this.run(), Math.max(0, next - this.now()));
	}

	private async run(): Promise<void> {
		const epoch = this.epoch;
		if (this.regularAt <= this.now())
			this.regularAt = this.now() + REGULAR_INTERVAL;
		this.retryAt = null;
		this.running = true;
		try {
			await this.check();
			if (epoch === this.epoch) this.retries = 0;
		} catch {
			if (epoch === this.epoch && this.retries < RETRY_BUDGET) {
				const delay = Math.min(15 * 60_000, 60_000 * 2 ** this.retries);
				this.retries += 1;
				this.retryAt =
					(this.pausedAt ?? this.now()) +
					Math.round(delay * (0.8 + this.random() * 0.4));
			}
		} finally {
			this.running = false;
			this.arm();
		}
	}
}
