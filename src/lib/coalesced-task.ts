import type { Scheduler } from "./scheduler.js";

export const REPO_CHANGE_DELAY_MS = 200;

interface Waiter {
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
}

export interface CoalescedTask {
	/** Schedules work at the first deadline and never moves that deadline. */
	invalidate(): void;
	/** Starts notification work now, retaining only one pending rerun while busy. */
	request(): void;
	/** Runs immediately when idle, or waits for one fresh run after active work. */
	run(): Promise<void>;
	dispose(): void;
}

interface CoalescedTaskOptions {
	delayMs?: number;
	onError?: (error: unknown) => void;
}

/**
 * Bounds an asynchronous reader to one active run and one pending rerun.
 * Invalidations are edge-triggered: a burst keeps the first deadline instead
 * of postponing it until the producer becomes quiet.
 */
export function createCoalescedTask(
	scheduler: Scheduler,
	work: () => Promise<void>,
	options: CoalescedTaskOptions = {},
): CoalescedTask {
	const { delayMs = REPO_CHANGE_DELAY_MS } = options;
	const onError =
		options.onError ??
		((error: unknown) => console.error("Coalesced task failed", error));
	let scheduled: number | null = null;
	let running = false;
	let rerunPending = false;
	let disposed = false;
	let waiters: Waiter[] = [];
	let activeWaiters: Waiter[] = [];

	function schedule(): void {
		if (disposed || running || scheduled !== null) return;
		scheduled = scheduler.setTimeout(() => {
			scheduled = null;
			void start();
		}, delayMs);
	}

	async function start(): Promise<void> {
		if (disposed || running) return;
		running = true;
		rerunPending = false;
		activeWaiters = waiters;
		waiters = [];

		try {
			await work();
			for (const waiter of activeWaiters) waiter.resolve();
		} catch (error) {
			if (activeWaiters.length > 0) {
				for (const waiter of activeWaiters) waiter.reject(error);
			} else if (!disposed) {
				onError(error);
			}
		} finally {
			activeWaiters = [];
			running = false;
			if (!disposed && (rerunPending || waiters.length > 0)) schedule();
		}
	}

	function invalidate(): void {
		if (disposed) return;
		rerunPending = true;
		schedule();
	}

	function request(): void {
		if (disposed) return;
		rerunPending = true;
		if (running) return;
		if (scheduled !== null) {
			scheduler.clearTimeout(scheduled);
			scheduled = null;
		}
		void start();
	}

	function run(): Promise<void> {
		if (disposed) return Promise.resolve();
		rerunPending = true;
		const completion = new Promise<void>((resolve, reject) => {
			waiters.push({ resolve, reject });
		});

		if (!running) {
			if (scheduled !== null) {
				scheduler.clearTimeout(scheduled);
				scheduled = null;
			}
			void start();
		}

		return completion;
	}

	function dispose(): void {
		disposed = true;
		rerunPending = false;
		if (scheduled !== null) scheduler.clearTimeout(scheduled);
		scheduled = null;
		for (const waiter of activeWaiters) waiter.resolve();
		activeWaiters = [];
		for (const waiter of waiters) waiter.resolve();
		waiters = [];
	}

	return { invalidate, request, run, dispose };
}
