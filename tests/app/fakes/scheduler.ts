import type { Scheduler, TimerOptions } from "../../../src/lib/scheduler.js";

/** A timer the application armed and this scheduler has not fired. */
interface Armed {
	handle: number;
	at: number;
	callback: () => void;
	background: boolean;
}

/**
 * The application's timers, frozen until a test fires them. Nothing here runs on
 * real time, so a debounce advances only when the test says so and no assertion
 * can pass by outlasting a window it guessed at.
 */
export class FakeScheduler implements Scheduler {
	private armed: Armed[] = [];
	private nextHandle = 1;
	private currentTime = 0;

	get time(): number {
		return this.currentTime;
	}

	currentTimeMs(): number {
		return this.currentTime;
	}

	/** How many timers the application is currently waiting on. */
	get pending(): number {
		return this.armed.length;
	}

	get pendingForeground(): number {
		return this.armed.filter((timer) => !timer.background).length;
	}

	/** When each armed foreground timer is due, soonest first, for a failure to
	 *  report what the application was waiting on. */
	get foregroundDeadlines(): number[] {
		return this.armed
			.filter((timer) => !timer.background)
			.map((timer) => timer.at)
			.sort((left, right) => left - right);
	}

	setTimeout(
		callback: () => void,
		delayMs: number,
		options?: TimerOptions,
	): number {
		const handle = this.nextHandle++;
		this.armed.push({
			handle,
			at: this.currentTime + delayMs,
			callback,
			background: options?.background ?? false,
		});

		return handle;
	}

	clearTimeout(handle: number): void {
		this.armed = this.armed.filter((timer) => timer.handle !== handle);
	}

	/** Fires everything armed right now in deadline order. A callback that arms
	 *  another timer leaves it for the next flush. */
	flush(): void {
		const firing = this.armed;
		this.armed = [];

		for (const timer of firing.sort((a, b) => a.at - b.at)) {
			this.currentTime = Math.max(this.currentTime, timer.at);
			timer.callback();
		}
	}

	flushForeground(): void {
		const deadlines = this.armed
			.filter((timer) => !timer.background)
			.map((timer) => timer.at);
		const horizon = Math.max(this.currentTime, ...deadlines);
		this.advanceBy(horizon - this.currentTime);
	}

	/** Advances virtual time and fires each timer whose deadline is reached. */
	advanceBy(elapsedMs: number): void {
		const until = this.currentTime + elapsedMs;
		for (;;) {
			const next = this.armed
				.filter((timer) => timer.at <= until)
				.sort((left, right) => left.at - right.at)[0];
			if (!next) break;
			this.currentTime = next.at;
			this.armed = this.armed.filter((timer) => timer.handle !== next.handle);
			next.callback();
		}
		this.currentTime = until;
	}
}
