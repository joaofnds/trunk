/** How a renamed file's two paths are written on one row. */
export interface RenameParts {
	/**
	 * The directory both paths share, trailing slash included, written once and
	 * scoping the two names. `""` when the file moved, and then `from` and `to`
	 * are whole paths.
	 */
	prefix: string;
	from: string;
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
 * A rename inside one directory names that directory once and scopes the two
 * filenames under it, which is what `git show --stat` does:
 * `code/{util.ts => math-util.ts}`. The two sides then mean the same kind of
 * thing — both are names within that directory.
 *
 * Writing the directory on only one side is the shape this replaced, and it was
 * wrong: `util.ts → code/math-util.ts` is a well-formed path pair, and read as
 * one it says the file moved from the repository root into `code/`. A reader has
 * no way to tell that the left side was abbreviated and the right side was not.
 *
 * A file that genuinely moved between directories has no shared directory to
 * name, so both paths stay whole and unscoped.
 */
export function renamePartsOf(
	path: string,
	oldPath: string | null,
): RenameParts | null {
	if (oldPath === null) return null;

	const directory = directoryOf(path);
	const shared = directory !== "" && directory === directoryOf(oldPath);

	if (!shared) return { prefix: "", from: oldPath, to: path };

	return {
		prefix: `${directory}/`,
		from: oldPath.slice(directory.length + 1),
		to: path.slice(directory.length + 1),
	};
}
