/** One "copy this path" entry in a file row's context menu. */
export interface PathMenuEntry {
	text: string;
	value: string;
}

/**
 * The path entries a file row's context menu offers.
 *
 * A renamed row names two files, so it offers both. Offering only the new path
 * makes the menu answer a question the user did not ask: the new path is the
 * one already legible on the row, and the old one is what they need to search
 * history or a build file for.
 */
export function pathMenuEntriesOf(
	repoPath: string,
	path: string,
	oldPath: string | null,
): PathMenuEntry[] {
	const entries = [
		{ text: "Copy Relative Path", value: path },
		{ text: "Copy Absolute Path", value: `${repoPath}/${path}` },
	];

	if (oldPath === null) return entries;

	return [
		...entries,
		{ text: "Copy Old Relative Path", value: oldPath },
		{ text: "Copy Old Absolute Path", value: `${repoPath}/${oldPath}` },
	];
}
