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
import {
	click,
	control,
	namesOf,
	pressKey,
	typeInto,
	waitFor,
} from "./drive-gestures.js";

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
	click(role: string, name: string): Promise<void>;
	type(role: string, name: string, text: string): Promise<void>;
	key(combo: string): void;
	list(role: string): string[];
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

/**
 * How long a wait watches before it gives up and lets go of its observer. A
 * drive window is always hidden, and WebKit throttles a hidden page's timers
 * (a 15s timer had not fired 25s later), so this often fires after the server
 * has stopped waiting (PAGE_DEADLINE in src-tauri/src/drive/mod.rs, 25s). The
 * client names the call that ran out (callHook in scripts/drive/client.ts).
 */
const WAIT_DEADLINE_MS = 20_000;

function until(expression: string): Promise<unknown> {
	return waitFor(expression, compile(expression), WAIT_DEADLINE_MS);
}

async function clickControl(role: string, name: string): Promise<void> {
	click(await control(role, name, WAIT_DEADLINE_MS));
}

async function typeIntoControl(
	role: string,
	name: string,
	text: string,
): Promise<void> {
	const field = await control(role, name, WAIT_DEADLINE_MS);
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
	) {
		throw new Error(`the ${role} named "${name}" takes no typed text`);
	}

	typeInto(field, text);
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

window.__trunkDrive = {
	run,
	until,
	click: clickControl,
	type: typeIntoControl,
	key: pressKey,
	list: namesOf,
	menu,
	choose,
};
void emit(READY);
