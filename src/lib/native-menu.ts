/**
 * The native menu API, loaded on the first menu rather than with the window.
 * Labels name refs, remotes and paths the repository supplies, and AppKit lays
 * out the bidi overrides and line separators git allows in them, so a label could
 * read as a different ref than the one its action touches. Every label passes
 * through `flattened` here, whole, because cutting it could drop the remote it
 * names.
 */

import type {
	CheckMenuItemOptions,
	MenuItemOptions,
	SubmenuOptions,
} from "@tauri-apps/api/menu";
import { flattened } from "./display-text.js";

export type { MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";

export async function nativeMenu() {
	const api = await import("@tauri-apps/api/menu");

	return {
		get Menu() {
			return api.Menu;
		},
		get PredefinedMenuItem() {
			return api.PredefinedMenuItem;
		},
		MenuItem: {
			new: (options: MenuItemOptions) =>
				api.MenuItem.new({ ...options, text: flattened(options.text) }),
		},
		CheckMenuItem: {
			new: (options: CheckMenuItemOptions) =>
				api.CheckMenuItem.new({ ...options, text: flattened(options.text) }),
		},
		Submenu: {
			new: (options: SubmenuOptions) =>
				api.Submenu.new({ ...options, text: flattened(options.text) }),
		},
	};
}
