/** How a renamed file's two paths are written on one row. */
export interface RenameParts {
	/** The old path, shortened to its filename when the file did not move. */
	from: string;
	/** The new path, always written in full. */
	to: string;
}

/** Everything before the last `/`, or "" for a file at the repository root. */
function directoryOf(path: string): string {
	const cut = path.lastIndexOf("/");

	return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Write a rename's two paths for a single-line row.
 *
 * A rename within one directory repeats that directory on both sides, which
 * says nothing and crowds out the two names the reader is comparing, so the old
 * side drops to its filename: `util.ts → code/math-util.ts`. A file that moved
 * between directories keeps both paths whole, because there the directories are
 * the change.
 *
 * This is lazygit's rule, which is the only surveyed client that solves the
 * shared-prefix problem for a one-line row. Two alternatives were rejected on
 * evidence. git's `--stat` braces, `code/{util.ts => math-util.ts}`, are the
 * shape João first suggested, but they survive truncation worst of every format
 * measured: `git show --stat=55` on a real rename gives
 * `.../NewWidgetName.svelte}`, a dangling brace that reads as corruption with
 * the rename itself no longer visible. A CSS ellipsis truncates right rather
 * than left, which would be worse still — it would keep the old name and hide
 * the new one. Repeating both paths in full, as GitLab does, doubles the row
 * and only works there because GitLab wraps instead of ellipsizing.
 *
 * The new path goes last so that it is the part an ellipsis keeps under
 * pressure, and it is never shortened: it is where the file is now.
 */
export function renamePartsOf(
	path: string,
	oldPath: string | null,
): RenameParts | null {
	if (oldPath === null) return null;

	const moved = directoryOf(path) !== directoryOf(oldPath);

	return {
		from: moved ? oldPath : (oldPath.split("/").pop() ?? oldPath),
		to: path,
	};
}
