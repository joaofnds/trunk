/** How a renamed file's two paths are written on one row. */
export interface RenameParts {
	from: string;
	to: string;
}

/**
 * Write a rename's two paths for a single-line row: both paths in full, always.
 *
 * Two shortening schemes were tried and both were worse. Dropping the directory
 * from the old side only produced `util.ts → code/math-util.ts`, which reads as
 * a move out of the repository root because nothing marks one side as
 * abbreviated. Scoping the names under a shared directory produced git's own
 * `code/{util.ts → math-util.ts}`, which is correct but asks the reader to
 * parse a form that changes shape depending on whether the file moved.
 *
 * Full paths are longer and repeat the directory, and they are never wrong.
 * This is what GitLab's diff header does. TRUNK-88 holds the research and the
 * reasoning if a shortened form is ever revisited.
 */
export function renamePartsOf(
	path: string,
	oldPath: string | null,
): RenameParts | null {
	if (oldPath === null) return null;

	return { from: oldPath, to: path };
}
