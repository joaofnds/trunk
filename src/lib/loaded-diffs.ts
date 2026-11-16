import type { ContentMode, DiffRequestOptions, FileDiff } from "./types.js";

/** One file's diff as a single load answered it. */
export interface LoadedDiff {
	readonly diff: FileDiff;
	readonly mode: ContentMode;
	readonly options: Readonly<DiffRequestOptions>;
}

/**
 * The diffs loaded for the files of one file list, kept beside the list rather
 * than patched into it, so reading the list again cannot drop them. `source`
 * is what the list was read for, such as a commit or a compared pair.
 */
export interface LoadedDiffs<Source> {
	readonly source: Source | null;
	readonly byPath: ReadonlyMap<string, LoadedDiff>;
}

export function noLoadedDiffs<Source>(): LoadedDiffs<Source> {
	return { source: null, byPath: new Map() };
}

/** Add `diff` for `path`, forgetting every diff loaded for another source. */
export function withLoadedDiff<Source>(
	loaded: LoadedDiffs<Source>,
	source: Source,
	path: string,
	diff: LoadedDiff,
): LoadedDiffs<Source> {
	const byPath = new Map(loaded.source === source ? loaded.byPath : []);
	byPath.set(path, diff);

	return { source, byPath };
}

export function loadedDiffFor<Source>(
	loaded: LoadedDiffs<Source>,
	source: Source | null,
	path: string,
): LoadedDiff | undefined {
	return loaded.source === source ? loaded.byPath.get(path) : undefined;
}

/** What the diff pane shows for `path`: its loaded diff, or until that loads,
 *  the list's own entry. */
export function shownDiff<Source>(
	list: readonly FileDiff[],
	loaded: LoadedDiffs<Source>,
	source: Source | null,
	path: string,
): FileDiff[] {
	const shown = loadedDiffFor(loaded, source, path);
	if (shown) return [shown.diff];

	return list.filter((file) => file.path === path);
}
