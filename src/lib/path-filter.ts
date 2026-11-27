import { extendedMatch, Fzf, type FzfResultItem } from "fzf";
import { filePathText } from "./file-path.js";
import type { FileStatus } from "./types.js";

export interface PathMatch {
	path: readonly number[];
	oldPath: readonly number[];
}

type PathEntry = Pick<FileStatus, "path" | "path_bytes" | "old_path_bytes"> & {
	old_path?: string | null;
};
type Filtered<T> = T & { match?: PathMatch };
export type FilteredFile = Filtered<FileStatus>;

interface Candidate<T> {
	file: T;
	side: keyof PathMatch;
	path: string;
	projectGraphemes: boolean;
	lastSlash: number;
	length: number;
}

function candidate<T>(
	file: T,
	side: keyof PathMatch,
	path: string,
): Candidate<T> {
	const astral = /[\u{10000}-\u{10ffff}]/u.test(path);
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const trimmed = path.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
	return {
		file,
		side,
		path,
		projectGraphemes: /[^ -~]/.test(path),
		lastSlash:
			astral && slash > 0 ? Array.from(path.slice(0, slash)).length : slash,
		length: astral ? Array.from(trimmed).length : trimmed.length,
	};
}

function basenameOffset<T>({
	item,
	start,
}: FzfResultItem<Candidate<T>>): number {
	return start >= 0 && start >= item.lastSlash
		? start - item.lastSlash
		: Number.MAX_SAFE_INTEGER;
}

function pathIndex<T extends PathEntry>(files: T[]) {
	const names: Candidate<T>[] = [];
	for (const file of files) {
		names.push(
			candidate(file, "path", filePathText(file.path, file.path_bytes)),
		);
		if (file.old_path)
			names.push(
				candidate(
					file,
					"oldPath",
					filePathText(file.old_path, file.old_path_bytes),
				),
			);
	}

	return new Fzf(names, {
		selector: (name) => name.path,
		match: extendedMatch,
		fuzzy: "v2",
		casing: "smart-case",
		normalize: true,
		sort: true,
		forward: false,
		tiebreakers: [
			(a, b) =>
				basenameOffset(a) - basenameOffset(b) || a.item.length - b.item.length,
		],
	});
}

let segmenter: Intl.Segmenter | undefined;

function displayPositions<T>(
	candidate: Candidate<T>,
	positions: Set<number>,
): number[] {
	const ordered = [...positions].sort((a, b) => a - b);
	if (!candidate.projectGraphemes || !ordered.length) return ordered;

	// fzf returns rune positions. A displayed grapheme can span several
	// UTF-16 units in the original Git path, even when only one rune matched.
	segmenter ??= new Intl.Segmenter();
	const mapped: number[] = [];
	let runeEnd = 0;
	let cursor = 0;
	for (const { segment, index } of segmenter.segment(candidate.path)) {
		runeEnd += Array.from(segment).length;
		if (ordered[cursor] >= runeEnd) continue;
		for (let offset = 0; offset < segment.length; offset++)
			mapped.push(index + offset);
		while (cursor < ordered.length && ordered[cursor] < runeEnd) cursor++;
		if (cursor === ordered.length) break;
	}
	return mapped;
}

export function createPathFilter<T extends PathEntry>(
	files: T[],
): (query: string) => Filtered<T>[] {
	let index: ReturnType<typeof pathIndex<T>> | undefined;
	return (query) => {
		if (/^ *$/.test(query)) return files;

		index ??= pathIndex(files);
		const matched = new Map<T, T & { match: PathMatch }>();
		for (const { item, positions } of index.find(query)) {
			let row = matched.get(item.file);
			if (!row) {
				row = { ...item.file, match: { path: [], oldPath: [] } };
				matched.set(item.file, row);
			}
			row.match[item.side] = displayPositions(item, positions);
		}

		return [...matched.values()];
	};
}
