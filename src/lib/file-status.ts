import type {
	DiffStatus,
	FileDiff,
	FileStatus,
	FileStatusType,
	WorkingTreeStatus,
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

// Git forbids NUL in paths, so ordinary names keep their existing key even
// when they spell exactly the same text as another name's byte escapes.
export function pathKey(path: string, bytes?: number[]): string {
	return bytes ? `${path}\0${JSON.stringify(bytes)}` : path;
}

export function fileKey(file: Pick<FileStatus, "path" | "path_bytes">): string {
	return pathKey(file.path, file.path_bytes);
}

export function atEitherPath(
	files: FileDiff[],
	key: string,
): FileDiff | undefined {
	return (
		files.find((file) => fileKey(file) === key) ??
		files.find(
			(file) =>
				file.old_path !== null &&
				pathKey(file.old_path, file.old_path_bytes) === key,
		)
	);
}

export function displayPath(key: string): string {
	const delimiter = key.indexOf("\0");
	return delimiter < 0 ? key : key.slice(0, delimiter);
}

export function gitPathArgument(key: string): string | number[] {
	const delimiter = key.indexOf("\0");
	return delimiter < 0 ? key : JSON.parse(key.slice(delimiter + 1));
}

export function toFileStatusList(fileDiffs: FileDiff[]): FileStatus[] {
	return fileDiffs.map((fd) => ({
		path: fd.path,
		old_path: fd.old_path,
		path_bytes: fd.path_bytes,
		old_path_bytes: fd.old_path_bytes,
		status: fileStatusOf(fd.status),
		is_binary: fd.is_binary,
	}));
}

/** Whether two status reads list the same files, each in the same section
 *  with the same status. */
export function listsSameFiles(
	before: WorkingTreeStatus,
	after: WorkingTreeStatus,
): boolean {
	return listingOf(before) === listingOf(after);
}

function listingOf(status: WorkingTreeStatus): string {
	const sections = [status.unstaged, status.staged, status.conflicted];

	return JSON.stringify(
		sections.map((files) => files.map((file) => [fileKey(file), file.status])),
	);
}

/** Displayed names and source names of moves both identify the changed file. */
export function matchingFiles(
	files: FileStatus[],
	query: string,
): FileStatus[] {
	if (!query) return files;
	const needle = query.toLowerCase();
	return files.filter(
		(file) =>
			file.path.toLowerCase().includes(needle) ||
			file.old_path?.toLowerCase().includes(needle),
	);
}
