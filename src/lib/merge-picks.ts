/** The lines taken in one conflicted file, or the output typed over them. */
export interface MergePicks {
	readonly taken: ReadonlySet<string>;
	readonly typed: string | null;
}

/**
 * The picks made in each conflicted file, kept while the user looks at another
 * file and for only as long as the file's sides read as they did.
 */
export interface MergePicksStore {
	get(repo: string, path: string, sides: string): MergePicks | undefined;
	set(repo: string, path: string, sides: string, picks: MergePicks): void;
	forget(repo: string, path: string): void;
}

export function createMergePicks(): MergePicksStore {
	const kept = new Map<string, { sides: string; picks: MergePicks }>();
	const keyOf = (repo: string, path: string) => `${repo}\0${path}`;

	return {
		get(repo, path, sides) {
			const entry = kept.get(keyOf(repo, path));

			return entry?.sides === sides ? entry.picks : undefined;
		},
		set(repo, path, sides, picks) {
			kept.set(keyOf(repo, path), { sides, picks });
		},
		forget(repo, path) {
			kept.delete(keyOf(repo, path));
		},
	};
}
