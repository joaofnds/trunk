import type { Scheduler } from "./scheduler.js";

/** How long a flash shows. The views hand it to their flash animations as
 *  `--diff-flash-duration`, so the class and the animation end together. */
export const FLASH_MS = 600;
export const FLASH_DURATION = `${FLASH_MS}ms`;

/**
 * The run of rows a jump just brought into view, lit for one flash so the
 * reader sees where it landed, even when the list could not scroll at all.
 *
 * Held as row indices rather than as a class on an element, because a row the
 * jump targets may not be mounted yet, and its node is reused for another row
 * as the reader scrolls away.
 */
export class RowFlash {
	#run = $state<{ from: number; to: number } | null>(null);
	#timer: number | null = null;
	readonly #scheduler: Scheduler;

	constructor(scheduler: Scheduler) {
		this.#scheduler = scheduler;
	}

	/** Lights rows `from` up to, not including, `to`. */
	show(from: number, to: number): void {
		this.stop();
		this.#run = { from, to };
		this.#timer = this.#scheduler.setTimeout(() => {
			this.#run = null;
			this.#timer = null;
		}, FLASH_MS);
	}

	lit(index: number): boolean {
		const run = this.#run;
		return run !== null && index >= run.from && index < run.to;
	}

	/** Cancels a flash still showing, for a view that unmounts. */
	stop(): void {
		if (this.#timer !== null) this.#scheduler.clearTimeout(this.#timer);
		this.#timer = null;
		this.#run = null;
	}
}
