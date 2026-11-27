import { LogicalPosition } from "@tauri-apps/api/dpi";
import { copyText } from "./clipboard.js";
import { type MenuItem, nativeMenu } from "./native-menu.js";

/** One "copy this path" entry in a file row's context menu. */
export interface PathMenuEntry {
	text: string;
	value: string;
}

/**
 * The path entries a file row's context menu offers.
 *
 * A renamed row names two files, so it offers both. Offering only the new path
 * makes the menu answer a question the user did not ask: the new path is the
 * one already legible on the row, and the old one is what they need to search
 * history or a build file for.
 */
export function pathMenuEntriesOf(
	repoPath: string,
	path: string,
	oldPath: string | null,
): PathMenuEntry[] {
	const entries = [
		{ text: "Copy Relative Path", value: path },
		{ text: "Copy Absolute Path", value: `${repoPath}/${path}` },
	];

	if (oldPath === null) return entries;

	return [
		...entries,
		{ text: "Copy Old Relative Path", value: oldPath },
		{ text: "Copy Old Absolute Path", value: `${repoPath}/${oldPath}` },
	];
}

/** A keyboard menu opens at its row. A pointer menu uses the native cursor position. */
export function fileMenuPosition(anchor?: DOMRect) {
	return anchor ? new LogicalPosition(anchor.left, anchor.bottom) : undefined;
}

export async function showFilePathMenu({
	repoPath,
	path,
	oldPath = null,
	anchor,
	onhistory,
}: {
	repoPath: string;
	path: string;
	oldPath?: string | null;
	anchor?: DOMRect;
	onhistory?: () => void;
}) {
	const api = await nativeMenu();
	const items: MenuItem[] = [];
	try {
		if (onhistory) {
			items.push(
				await api.MenuItem.new({
					text: "Show commits touching this path",
					action: onhistory,
				}),
			);
		}
		for (const { text, value } of pathMenuEntriesOf(repoPath, path, oldPath)) {
			items.push(
				await api.MenuItem.new({ text, action: () => void copyText(value) }),
			);
		}
		const menu = await api.Menu.new({ items });
		try {
			await menu.popup(fileMenuPosition(anchor));
		} finally {
			await menu.close();
		}
	} finally {
		await Promise.all(items.map((item) => item.close()));
	}
}
