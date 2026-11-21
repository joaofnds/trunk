import type { RevSpec } from "./markdown.js";
import type { FileDiff } from "./types.js";

// The extensions the asset protocol serves with an image type. Any other file
// arrives as application/octet-stream, which nosniff keeps the webview from
// drawing.
const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"svg",
	"webp",
	"avif",
	"bmp",
	"ico",
]);

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

export function isImagePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
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
	file: Pick<FileDiff, "old_size" | "new_size">,
): string {
	const { old_size: before, new_size: after } = file;

	if (before !== null && after !== null)
		return `Binary file, ${formatSize(before)} → ${formatSize(after)}`;
	if (after !== null) return `Binary file added, ${formatSize(after)}`;
	if (before !== null) return `Binary file deleted, ${formatSize(before)}`;
	return "Binary file";
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
 * version, so the webview asks again after each refresh rather than drawing
 * the copy it cached.
 */
export function assetUrl(asset: {
	repo: string;
	rev: RevSpec;
	path: string;
	version: number;
}): string {
	const { repo, rev, path, version } = asset;
	const url = `trunk-asset://asset/?repo=${encodeURIComponent(repo)}&rev=${encodeURIComponent(revToken(rev))}&path=${encodeURIComponent(path)}`;
	const moves = rev.type !== "commit" && rev.type !== "empty";

	return moves ? `${url}&v=${version}` : url;
}
