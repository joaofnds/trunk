import type { ContentMode, DiffRequestOptions, FileDiff } from "./types.js";

/** One file's diff as a single load answered it. */
export interface LoadedDiff {
	readonly diff: FileDiff;
	readonly options: Readonly<DiffRequestOptions>;
}

/**
 * The diffs loaded for the files of one file list. `source` is what the list
 * was read for, such as a commit or a compared pair, and a diff answers only
 * for that source.
 */
export interface LoadedDiffs<Source> {
	readonly source: Source | null;
	readonly byPath: ReadonlyMap<string, LoadedDiff>;
}

/** A file in the list read for `source`. */
export interface DiffSlot<Source> {
	readonly source: Source | null;
	readonly path: string;
}

export function noLoadedDiffs<Source>(): LoadedDiffs<Source> {
	return { source: null, byPath: new Map() };
}

/** Add `diff` at `slot`, forgetting every diff loaded for another source. */
export function withLoadedDiff<Source>(
	loaded: LoadedDiffs<Source>,
	slot: DiffSlot<Source> & { readonly source: Source },
	diff: LoadedDiff,
): LoadedDiffs<Source> {
	const byPath = new Map(loaded.source === slot.source ? loaded.byPath : []);
	byPath.set(slot.path, diff);

	return { source: slot.source, byPath };
}

export function loadedDiffFor<Source>(
	loaded: LoadedDiffs<Source>,
	slot: DiffSlot<Source>,
): LoadedDiff | undefined {
	return loaded.source === slot.source
		? loaded.byPath.get(slot.path)
		: undefined;
}

export function modeFor(options: DiffRequestOptions): ContentMode {
	return options.showFullFile ? "full" : "hunk";
}

/** The mode of the diff loaded at `slot`, or null while none is. */
export function loadedModeFor<Source>(
	loaded: LoadedDiffs<Source>,
	slot: DiffSlot<Source>,
): ContentMode | null {
	const diff = loadedDiffFor(loaded, slot);

	return diff ? modeFor(diff.options) : null;
}

/** What the diff pane shows at `slot`: its loaded diff, or until that loads,
 *  the list's own entry. */
export function shownDiff<Source>(
	list: readonly FileDiff[],
	loaded: LoadedDiffs<Source>,
	slot: DiffSlot<Source>,
): FileDiff[] {
	const shown = loadedDiffFor(loaded, slot);
	if (shown) return [shown.diff];

	return list.filter((file) => file.path === slot.path);
}
