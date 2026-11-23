import { SvelteSet } from "svelte/reactivity";

export interface MergePosition {
	readonly conflict: number;
	readonly fullFile: boolean;
	readonly expanded: readonly number[];
	readonly sourceTop: number;
	readonly sourceLeft: number;
	readonly outputTop: number;
	readonly outputLeft: number;
	readonly start: number;
	readonly end: number;
	readonly direction: "forward" | "backward" | "none";
}

/** The lines taken in one conflicted file, or the output typed over them. */
export interface MergePicks {
	readonly taken: ReadonlySet<string>;
	readonly typed: string | null;
	readonly selectedOutput?: string;
	readonly position?: MergePosition;
}

interface FileDraft {
	readonly revision: string;
	readonly refusalReason?: string;
	picks: MergePicks;
}

/**
 * The picks made in each conflicted file, kept while the user looks at another
 * file and for only as long as the file's sides read as they did.
 */
export interface MergePicksStore {
	get(repo: string, path: string): FileDraft | undefined;
	draftText(repo: string, path: string): string | undefined;
	draftPaths(repo: string): string[];
	isSaving(repo: string, path: string): boolean;
	startSave(repo: string, path: string): (() => void) | undefined;
	refused(
		repo: string,
		path: string,
		revision: string,
		text: string,
		reason: string,
	): void;
	set(repo: string, path: string, sides: string, picks: MergePicks): void;
	rememberPosition(
		repo: string,
		path: string,
		sides: string,
		position: MergePosition,
	): void;
	forget(repo: string, path: string): void;
}

export function createMergePicks(): MergePicksStore {
	const kept = new Map<string, FileDraft>();
	const drafts = new SvelteSet<string>();
	const saving = new SvelteSet<string>();
	const keyOf = (repo: string, path: string) => `${repo}\0${path}`;

	return {
		get(repo, path) {
			return kept.get(keyOf(repo, path));
		},
		draftText(repo, path) {
			const picks = kept.get(keyOf(repo, path))?.picks;
			return picks?.typed ?? picks?.selectedOutput;
		},
		draftPaths(repo) {
			const prefix = `${repo}\0`;
			return [...drafts]
				.filter((key) => key.startsWith(prefix))
				.map((key) => key.slice(prefix.length));
		},
		isSaving(repo, path) {
			return saving.has(keyOf(repo, path));
		},
		startSave(repo, path) {
			const key = keyOf(repo, path);
			if (saving.has(key)) return;

			saving.add(key);
			return () => {
				saving.delete(key);
			};
		},
		refused(repo, path, revision, text, reason) {
			const key = keyOf(repo, path);
			const entry = kept.get(key);
			if (entry?.revision !== revision) return;

			drafts.add(key);
			kept.set(key, {
				...entry,
				refusalReason: reason,
				picks: { ...entry.picks, typed: text },
			});
		},
		set(repo, path, sides, picks) {
			const key = keyOf(repo, path);
			const previous = kept.get(key);
			const position =
				previous?.revision === sides ? previous.picks.position : undefined;
			kept.set(key, { revision: sides, picks: { ...picks, position } });
			if (picks.typed !== null || picks.selectedOutput !== undefined)
				drafts.add(key);
			else drafts.delete(key);
		},
		rememberPosition(repo, path, sides, position) {
			const entry = kept.get(keyOf(repo, path));
			if (entry?.revision === sides) entry.picks = { ...entry.picks, position };
		},
		forget(repo, path) {
			const key = keyOf(repo, path);
			kept.delete(key);
			drafts.delete(key);
		},
	};
}
