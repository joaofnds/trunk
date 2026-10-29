/**
 * A wait for something the drive route (src/drive.ts) records outside the
 * page's DOM, such as a context menu or a folder picker, which a wait on DOM
 * changes would never see.
 */

export class Signal {
	#waiting = new Set<() => void>();

	/** Resolves at the next release, or rejects with `awaited` after
	 *  `deadlineMs`. */
	next(awaited: string, deadlineMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const release = () => {
				clearTimeout(timer);
				this.#waiting.delete(release);
				resolve();
			};
			const timer = setTimeout(() => {
				this.#waiting.delete(release);
				reject(new Error(`no ${awaited} showed in ${deadlineMs}ms`));
			}, deadlineMs);
			this.#waiting.add(release);
		});
	}

	/** Lets every current wait go. */
	release(): void {
		for (const release of [...this.#waiting]) release();
	}
}
