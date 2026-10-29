/**
 * The drive build's stand-in for the native Open panel (src/drive-dialog.ts):
 * the app's request waits here until the agent answers it with a path or
 * dismisses it.
 */

import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";

/** What the dialog plugin's open command hands back: a path, a list of them
 *  for a multiple selection, or null when the user cancels. */
export type OpenAnswer = string | string[] | null;

interface Showing {
	options: OpenDialogOptions;
	settle: (answer: OpenAnswer) => void;
}

export class OpenPanel {
	#showing: Showing | null = null;

	/** The app's request, answered once the agent answers it. */
	ask(options: OpenDialogOptions): Promise<OpenAnswer> {
		if (this.#showing) {
			return Promise.reject(new Error("a folder picker is already showing"));
		}

		return new Promise((settle) => {
			this.#showing = { options, settle };
		});
	}

	/** The options of the picker waiting on an answer, or null when none is. */
	showing(): OpenDialogOptions | null {
		return this.#showing?.options ?? null;
	}

	/** Chooses `path`, as a user picking it and pressing Open does. */
	answer(path: string): void {
		const { options, settle } = this.#close();
		settle(options.multiple ? [path] : path);
	}

	/** Closes the picker with nothing chosen, as Cancel does. */
	dismiss(): void {
		this.#close().settle(null);
	}

	#close(): Showing {
		const showing = this.#showing;
		if (!showing) throw new Error("no folder picker is showing");

		this.#showing = null;
		return showing;
	}
}
