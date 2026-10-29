/**
 * The context menu the drive route (src/drive.ts) recorded in place of showing
 * it, read as a tree and chosen from by the labels a user reads on it.
 */

import { Signal } from "./drive-signal.js";

/** One item of a recorded menu, as it read when the app popped the menu up. */
export interface RecordedItem {
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	/** The items it opens, or null for an item that runs an action. */
	readonly submenu: readonly RecordedItem[] | null;
}

/** What the agent is shown of one item. */
export interface ShownItem {
	readonly label: string;
	readonly enabled: boolean;
	readonly submenu?: readonly ShownItem[];
}

export function shownAs(menu: readonly RecordedItem[]): ShownItem[] {
	return menu.map((item) =>
		item.submenu
			? {
					label: item.label,
					enabled: item.enabled,
					submenu: shownAs(item.submenu),
				}
			: { label: item.label, enabled: item.enabled },
	);
}

/**
 * The item `path` names, one label per level, refused unless a user could
 * choose it: every level shown and enabled, and the last one an action.
 */
export function itemAt(
	menu: readonly RecordedItem[],
	path: readonly string[],
	within = "",
): RecordedItem {
	const [label, ...rest] = path;
	if (label === undefined) throw new Error("name the menu item to choose");

	const item = menu.find((candidate) => candidate.label === label);
	if (!item) {
		const where = within ? ` in ${within}` : "";
		throw new Error(`no menu item labelled "${label}" is showing${where}`);
	}
	if (!item.enabled)
		throw new Error(`the menu item labelled "${label}" is disabled`);

	if (rest.length === 0) {
		if (item.submenu)
			throw new Error(`"${label}" opens a submenu; name one of its items too`);
		return item;
	}
	if (!item.submenu)
		throw new Error(`"${label}" has no submenu to find "${rest[0]}" in`);

	return itemAt(item.submenu, rest, label);
}

/**
 * The menu the app popped up, held until a press reaches the page, as a real
 * menu closes on one.
 */
export class ShowingMenu {
	#items: readonly RecordedItem[] | null = null;
	#closes = 0;
	#recorded = new Signal();

	/** Holds the menu `read` gives, unless a press closed it while it was
	 *  being read. */
	async record(read: () => Promise<readonly RecordedItem[]>): Promise<void> {
		const closes = this.#closes;
		const items = await read();
		if (this.#closes !== closes) return;

		this.#items = items;
		this.#recorded.release();
	}

	close(): void {
		this.#closes += 1;
		this.#items = null;
	}

	/** The menu showing, or the next one recorded within `deadlineMs`. */
	async next(deadlineMs: number): Promise<readonly RecordedItem[]> {
		while (!this.#items) {
			await this.#recorded.next("context menu", deadlineMs);
		}
		return this.#items;
	}
}
