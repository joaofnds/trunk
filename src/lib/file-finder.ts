import type { TrackedFile } from "./types.js";

// Ranking for the file finder: which tracked files a query matches, and in what
// order they appear.
//
// Changed files come first whatever the query scores, because the finder's
// common gesture is reaching a file the user is already working on; the score
// orders within each of the two groups rather than across them.

/** How much better a run of adjacent matched characters is than a scattered one. */
const CONTIGUITY_BONUS = 8;

/** How much better a match inside the file's name is than one in its directories. */
const FILENAME_BONUS = 40;

/**
 * The tracked files a query matches, changed files first and better matches
 * before worse ones inside each group.
 *
 * An empty query matches every file. A query matches a path when the path
 * contains the query's characters in order, case-insensitively, which is the
 * usual subsequence rule a fuzzy finder uses.
 */
export function rankFiles(files: TrackedFile[], query: string): TrackedFile[] {
	const needle = query.trim().toLowerCase();

	const scored = files
		.map((file) => ({ file, score: scorePath(file.path, needle) }))
		.filter((row) => row.score !== null);

	scored.sort((a, b) => {
		if (a.file.changed !== b.file.changed) return a.file.changed ? -1 : 1;
		if (a.score !== b.score) return (b.score ?? 0) - (a.score ?? 0);
		return a.file.path.localeCompare(b.file.path);
	});

	return scored.map((row) => row.file);
}

/**
 * How well `path` matches `needle`, or null when it does not match at all.
 *
 * Scored twice: once over the whole path, once over the filename alone, taking
 * the better. One pass is not enough because the walk is greedy from the left,
 * so a query that also occurs in a directory is consumed there and never
 * reaches the name — which ranked `panel/other.ts` above `panel/src/panel.ts`
 * for "panel". The filename pass starts after the last slash, so it cannot be
 * captured that way.
 */
function scorePath(path: string, needle: string): number | null {
	if (needle === "") return 0;

	const haystack = path.toLowerCase();
	const filenameStart = haystack.lastIndexOf("/") + 1;

	const wholePath = walk(haystack, needle, filenameStart);
	const filenameOnly = walk(haystack.slice(filenameStart), needle, 0);

	if (filenameOnly === null) return wholePath;
	// Every matched character sat in the filename, which the whole-path pass
	// scores the same way, so this is that pass's best possible outcome.
	const named = filenameOnly + FILENAME_BONUS * needle.length;

	return wholePath === null ? named : Math.max(wholePath, named);
}

/**
 * One left-to-right subsequence walk, or null when `needle` is not one.
 *
 * The walk takes the earliest occurrence of each query character, which is what
 * makes a single pass enough: a later occurrence can only push the remaining
 * characters further right, never fit more of them.
 */
function walk(
	haystack: string,
	needle: string,
	filenameStart: number,
): number | null {
	let score = 0;
	let searchFrom = 0;
	let previousIndex = -2;

	for (const char of needle) {
		const found = haystack.indexOf(char, searchFrom);
		if (found === -1) return null;

		if (found === previousIndex + 1) score += CONTIGUITY_BONUS;
		if (found >= filenameStart) score += FILENAME_BONUS;

		previousIndex = found;
		searchFrom = found + 1;
	}

	return score;
}
