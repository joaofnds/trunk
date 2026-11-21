import IMAGE_TYPES from "./image-types.json";
import type { RevSpec } from "./rev-spec.js";
import type { FileDiff } from "./types.js";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/**
 * Whether the webview can draw the file. The asset protocol serves only the
 * extensions in the shared table with an image type, and nosniff keeps the
 * webview from drawing anything it serves as octet-stream.
 */
export function isImagePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return Object.hasOwn(IMAGE_TYPES, path.slice(dot + 1).toLowerCase());
}

/** A size in bytes the way Finder writes one: decimal units, three digits. */
export function formatSize(bytes: number): string {
	if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;

	let value = bytes / 1000;
	let unit = 0;
	while (Number(value.toPrecision(3)) >= 1000 && unit < SIZE_UNITS.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${Number(value.toPrecision(3))} ${SIZE_UNITS[unit]}`;
}

export function binarySummary(
	file: Pick<FileDiff, "status" | "old_size" | "new_size">,
): string {
	const { status, old_size: before, new_size: after } = file;

	if ((status === "Added" || status === "Untracked") && after !== null)
		return `Binary file added, ${formatSize(after)}`;
	if (status === "Deleted" && before !== null)
		return `Binary file deleted, ${formatSize(before)}`;
	if (before !== null && after !== null)
		return `Binary file, ${formatSize(before)} → ${formatSize(after)}`;
	const known = after ?? before;
	return known === null ? "Binary file" : `Binary file, ${formatSize(known)}`;
}

function revToken(rev: RevSpec): string {
	switch (rev.type) {
		case "workingTree":
			return "working-tree";
		case "index":
			return "index";
		case "head":
			return "head";
		case "empty":
			return "empty";
		case "commit":
			return `commit-${rev.oid}`;
	}
}

/**
 * The asset protocol's URL for a file at a rev. A rev that moves carries the
 * version, which names the content where it is known, so the webview draws
 * the copy it cached only when that copy is the content asked for.
 */
export function assetUrl(asset: {
	repo: string;
	rev: RevSpec;
	path: string;
	version: string | number;
}): string {
	const { repo, rev, path, version } = asset;
	const url = `trunk-asset://asset/?repo=${encodeURIComponent(repo)}&rev=${encodeURIComponent(revToken(rev))}&path=${encodeURIComponent(path)}`;
	const moves = rev.type !== "commit" && rev.type !== "empty";

	return moves ? `${url}&v=${version}` : url;
}
