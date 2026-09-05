import { onDestroy } from "svelte";
import { getScheduler } from "./scheduler.js";

/** At most one pending callback, which the owning component takes down with it. */
export interface OwnedTimer {
	/** Replaces whatever is pending. Arms nothing once the component is destroyed. */
	arm(callback: () => void, delayMs: number): void;
	cancel(): void;
}

/**
 * Call during component initialisation: the timer reads the scheduler from
 * context and is cancelled when the component is destroyed, so a callback can
 * never fire against a component that no longer exists.
 */
export function createOwnedTimer(): OwnedTimer {
	const scheduler = getScheduler();
	let handle: number | null = null;
	let destroyed = false;

	function cancel() {
		if (handle === null) return;

		scheduler.clearTimeout(handle);
		handle = null;
	}

	function arm(callback: () => void, delayMs: number) {
		cancel();
		if (destroyed) return;

		handle = scheduler.setTimeout(() => {
			handle = null;
			callback();
		}, delayMs);
	}

	onDestroy(() => {
		destroyed = true;
		cancel();
	});

	return { arm, cancel };
}
