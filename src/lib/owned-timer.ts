import { onDestroy } from "svelte";
import { getScheduler, type Scheduler } from "./scheduler.js";

/** At most one pending callback, which the owning component takes down with it. */
export interface OwnedTimer {
	/** Replaces whatever is pending. */
	arm(callback: () => void, delayMs: number): void;
	cancel(): void;
}

/**
 * Call during component initialisation: the timer reads the scheduler from
 * context and is cancelled when the component is destroyed, so a callback can
 * never fire against a component that no longer exists.
 */
export function ownedTimer(scheduler: Scheduler = getScheduler()): OwnedTimer {
	let handle: number | null = null;

	function cancel() {
		if (handle === null) return;

		scheduler.clearTimeout(handle);
		handle = null;
	}

	function arm(callback: () => void, delayMs: number) {
		cancel();

		handle = scheduler.setTimeout(() => {
			handle = null;
			callback();
		}, delayMs);
	}

	onDestroy(cancel);

	return { arm, cancel };
}
