import type {
	DiffStatus,
	FileDiff,
	FileStatus,
	FileStatusType,
} from "./types.js";

// Diff deltas speak git2's vocabulary; the file lists speak the staging
// panel's. One mapping, shared by every changed-file list.
const DIFF_STATUS_MAP: Record<string, FileStatusType> = {
	Added: "New",
	Deleted: "Deleted",
	Modified: "Modified",
	Renamed: "Renamed",
	Copied: "Modified",
	Untracked: "New",
	Unknown: "Modified",
};

export function fileStatusOf(status: DiffStatus): FileStatusType {
	return DIFF_STATUS_MAP[status] ?? "Modified";
}

export function toFileStatusList(fileDiffs: FileDiff[]): FileStatus[] {
	return fileDiffs.map((fd) => ({
		path: fd.path,
		old_path: fd.old_path,
		status: fileStatusOf(fd.status),
		is_binary: fd.is_binary,
	}));
}

/**
 * Replace a file list's lightweight (hunkless) entry with the diff loaded for
 * it, leaving every other entry alone. An empty load keeps the entry.
 */
export function patchLoadedDiff(
	list: FileDiff[],
	path: string,
	loaded: FileDiff[],
): FileDiff[] {
	return list.map((fd) =>
		fd.path === path && loaded.length > 0 ? loaded[0] : fd,
	);
}
