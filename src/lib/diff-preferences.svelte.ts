import {
	getDiffContextLines,
	getDiffIgnoreWhitespace,
	getDiffLayoutMode,
	getDiffShowInvisibles,
	getDiffWordWrap,
	getRenderMode,
	setDiffIgnoreWhitespace,
	setDiffLayoutMode,
	setDiffShowInvisibles,
	setDiffWordWrap,
	setRenderMode,
} from "./store.js";
import { showToast } from "./toast.svelte.js";
import type {
	ContentMode,
	DiffRequestOptions,
	LayoutMode,
	RenderMode,
} from "./types.js";

export interface DiffSettings {
	readonly layoutMode: LayoutMode;
	readonly renderMode: RenderMode;
	readonly contextLines: number;
	readonly ignoreWhitespace: boolean;
	readonly showInvisibles: boolean;
	readonly wordWrap: boolean;
}

const DEFAULT_SETTINGS: DiffSettings = {
	layoutMode: "inline",
	renderMode: "source",
	contextLines: 3,
	ignoreWhitespace: false,
	showInvisibles: false,
	wordWrap: false,
};

/**
 * How diffs are shown, one set for the whole app: a setting changed in any
 * tab's diff holds in every open tab at once, and is saved for the next launch.
 */
export class DiffPreferences {
	#layoutMode = $state(DEFAULT_SETTINGS.layoutMode);
	#renderMode = $state(DEFAULT_SETTINGS.renderMode);
	#contextLines = $state(DEFAULT_SETTINGS.contextLines);
	#ignoreWhitespace = $state(DEFAULT_SETTINGS.ignoreWhitespace);
	#showInvisibles = $state(DEFAULT_SETTINGS.showInvisibles);
	#wordWrap = $state(DEFAULT_SETTINGS.wordWrap);

	constructor(settings: DiffSettings) {
		this.#layoutMode = settings.layoutMode;
		this.#renderMode = settings.renderMode;
		this.#contextLines = settings.contextLines;
		this.#ignoreWhitespace = settings.ignoreWhitespace;
		this.#showInvisibles = settings.showInvisibles;
		this.#wordWrap = settings.wordWrap;
	}

	static defaults(): DiffPreferences {
		return new DiffPreferences(DEFAULT_SETTINGS);
	}

	/** The saved settings. A store that cannot be read gives the defaults, and
	 *  the user is told, since their settings then appear to have reset. */
	static async load(): Promise<DiffPreferences> {
		try {
			const [
				layoutMode,
				renderMode,
				contextLines,
				ignoreWhitespace,
				showInvisibles,
				wordWrap,
			] = await Promise.all([
				getDiffLayoutMode(),
				getRenderMode(),
				getDiffContextLines(),
				getDiffIgnoreWhitespace(),
				getDiffShowInvisibles(),
				getDiffWordWrap(),
			]);

			return new DiffPreferences({
				layoutMode,
				renderMode,
				contextLines,
				ignoreWhitespace,
				showInvisibles,
				wordWrap,
			});
		} catch {
			showToast("Could not load diff settings", "error");
			return DiffPreferences.defaults();
		}
	}

	get layoutMode(): LayoutMode {
		return this.#layoutMode;
	}

	get renderMode(): RenderMode {
		return this.#renderMode;
	}

	get contextLines(): number {
		return this.#contextLines;
	}

	get ignoreWhitespace(): boolean {
		return this.#ignoreWhitespace;
	}

	get showInvisibles(): boolean {
		return this.#showInvisibles;
	}

	get wordWrap(): boolean {
		return this.#wordWrap;
	}

	/** The options a diff read for `contentMode` is made with. */
	requestOptions(contentMode: ContentMode): DiffRequestOptions {
		return {
			contextLines: this.#contextLines,
			ignoreWhitespace: this.#ignoreWhitespace,
			showFullFile: contentMode === "full",
		};
	}

	changeLayoutMode(mode: LayoutMode): void {
		this.#layoutMode = mode;
		save(setDiffLayoutMode(mode));
	}

	changeRenderMode(mode: RenderMode): void {
		this.#renderMode = mode;
		save(setRenderMode(mode));
	}

	changeIgnoreWhitespace(ignore: boolean): void {
		this.#ignoreWhitespace = ignore;
		save(setDiffIgnoreWhitespace(ignore));
	}

	changeShowInvisibles(show: boolean): void {
		this.#showInvisibles = show;
		save(setDiffShowInvisibles(show));
	}

	changeWordWrap(wrap: boolean): void {
		this.#wordWrap = wrap;
		save(setDiffWordWrap(wrap));
	}
}

/** A setting that cannot be saved still holds for this session, and the user
 *  is told it will not survive a relaunch. */
function save(write: Promise<void>): void {
	write.catch(() => showToast("Could not save diff settings", "error"));
}
