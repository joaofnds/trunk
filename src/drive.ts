/**
 * The page half of the drive route (src-tauri/src/drive/mod.rs), loaded only by
 * the drive build. The socket's evaluations arrive here, and their awaited
 * results go back as events, since the webview's own completion handler cannot
 * carry a Promise's result.
 *
 * A context menu is recorded rather than shown, because a menu popped up with
 * no position opens under the user's real cursor and its tracking loop takes
 * their input. Each item's action is kept as the app created it, so choosing an
 * item runs the same code a click on it would, skipping only the native hop
 * from the menu to the item's channel.
 */

import { emit } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";

const READY = "trunk-drive:ready";
const REPLY = "trunk-drive:reply";

type MenuAction = (id: string) => void;

/** One item of the recorded menu, as the user reads it. */
interface MenuEntry {
	label: string;
	enabled: boolean;
}

interface DriveHooks {
	run(id: number, expression: string): Promise<void>;
	until(expression: string): Promise<unknown>;
	menu(): Promise<MenuEntry[]>;
	choose(label: string): Promise<void>;
}

declare global {
	interface Window {
		__trunkDrive: DriveHooks;
	}
}

function compile(expression: string): () => unknown {
	return new Function(`return (${expression});`) as () => unknown;
}

async function run(id: number, expression: string): Promise<void> {
	try {
		const value = await compile(expression)();
		await emit(REPLY, { id, ok: true, value: value ?? null });
	} catch (error) {
		const message =
			error instanceof Error ? `${error.name}: ${error.message}` : `${error}`;
		await emit(REPLY, { id, ok: false, error: message });
	}
}

/** The first truthy value `expression` takes, re-read after each DOM change. */
/**
 * How long `until` watches before it gives up, matching the server's wait for an
 * answer (PAGE_DEADLINE in src-tauri/src/drive/mod.rs), so no observer outlives
 * the request that started it.
 */
const UNTIL_DEADLINE_MS = 25_000;

function until(expression: string): Promise<unknown> {
	const read = compile(expression);

	return new Promise((resolve, reject) => {
		const observer = new MutationObserver(check);
		const timer = setTimeout(() => {
			observer.disconnect();
			reject(
				new Error(`${expression} stayed falsy for ${UNTIL_DEADLINE_MS}ms`),
			);
		}, UNTIL_DEADLINE_MS);
		function check() {
			let value: unknown;
			try {
				value = read();
			} catch (error) {
				observer.disconnect();
				clearTimeout(timer);
				reject(error);
				return;
			}
			if (!value) return;

			observer.disconnect();
			clearTimeout(timer);
			resolve(value);
		}

		observer.observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		check();
	});
}

const actions = new Map<string, MenuAction>();
let showing: Menu | null = null;

const newMenuItem = MenuItem.new.bind(MenuItem);
MenuItem.new = async (options) => {
	const action = options.action;
	const item = await newMenuItem(options);
	if (action) actions.set(item.id, action);
	return item;
};

const newCheckMenuItem = CheckMenuItem.new.bind(CheckMenuItem);
CheckMenuItem.new = async (options) => {
	const action = options.action;
	const item = await newCheckMenuItem(options);
	if (action) actions.set(item.id, action);
	return item;
};

Menu.prototype.popup = async function record(this: Menu) {
	showing = this;
};

async function showingItems(): Promise<(MenuItem | CheckMenuItem)[]> {
	if (!showing) return [];

	const items = await showing.items();
	return items.filter(
		(item): item is MenuItem | CheckMenuItem =>
			item instanceof MenuItem || item instanceof CheckMenuItem,
	);
}

/** Every item of the menu the app last popped up, separators dropped, or an
 *  empty list while none is showing. */
async function menu(): Promise<MenuEntry[]> {
	const items = await showingItems();

	return Promise.all(
		items.map(async (item) => ({
			label: await item.text(),
			enabled: await item.isEnabled(),
		})),
	);
}

/** Picks an item the way a user does, by the label they read on it. */
async function choose(label: string): Promise<void> {
	const items = await showingItems();
	const labels = await Promise.all(items.map((item) => item.text()));
	const item = items[labels.indexOf(label)];

	if (!item) throw new Error(`no menu item labelled "${label}" is showing`);
	if (!(await item.isEnabled()))
		throw new Error(`the menu item labelled "${label}" is disabled`);
	const action = actions.get(item.id);
	if (!action)
		throw new Error(`the menu item labelled "${label}" has no action`);

	showing = null;
	action(item.id);
}

window.__trunkDrive = { run, until, menu, choose };
void emit(READY);
