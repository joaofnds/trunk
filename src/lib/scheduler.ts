import { getContext } from "svelte";

/** The timer calls a component makes, as a dependency it can be handed instead
 *  of reaching for the global. A test installs a fake through `mount`'s context
 *  option and advances the component's debounces deliberately, rather than
 *  waiting out a window longer than they are. */
export interface Scheduler {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

export const SCHEDULER = Symbol("scheduler");

/**
 * Resolves `globalThis` per call rather than at import, so a suite that installs
 * `vi.useFakeTimers()` after this module loads still intercepts.
 */
export const realScheduler: Scheduler = {
	setTimeout: (callback, delayMs) =>
		globalThis.setTimeout(callback, delayMs) as unknown as number,
	clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function getScheduler(): Scheduler {
	return getContext<Scheduler | undefined>(SCHEDULER) ?? realScheduler;
}
