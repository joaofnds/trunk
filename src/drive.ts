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
 * from the menu to the item's channel. The recorded menu is dropped once a
 * pointer or key press, or typed text, reaches the page, as a real menu closes
 * on one.
 *
 * The folder picker the dialog plugin opens waits for the agent's answer the
 * same way (src/drive-dialog.ts).
 */

import { emit } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { openPanel } from "./drive-dialog.js";
import {
	click,
	control,
	namesOf,
	pressKey,
	rightClick,
	typeInto,
	waitFor,
} from "./drive-gestures.js";
import {
	itemAt,
	type RecordedItem,
	ShowingMenu,
	type ShownItem,
	shownAs,
} from "./drive-menu.js";

const READY = "trunk-drive:ready";
const REPLY = "trunk-drive:reply";

type MenuAction = (id: string) => void;

interface DriveHooks {
	run(id: number, expression: string): Promise<void>;
	until(expression: string): Promise<unknown>;
	click(role: string, name: string, within?: string): Promise<void>;
	context(role: string, name: string, within?: string): Promise<void>;
	type(
		role: string,
		name: string,
		text: string,
		within?: string,
	): Promise<void>;
	key(combo: string): void;
	list(role: string): string[];
	menu(): Promise<readonly ShownItem[]>;
	choose(...path: string[]): Promise<void>;
	picker(): Promise<OpenDialogOptions>;
	pick(path: string): void;
	dismissPicker(): void;
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
 * How long a wait watches before it gives up and lets go of its observer. It
 * runs out before the server stops waiting (PAGE_DEADLINE in
 * src-tauri/src/drive/mod.rs, 25s), so the caller reads what the page waited
 * for rather than the server's bare timeout.
 */
const WAIT_DEADLINE_MS = 20_000;

function until(expression: string): Promise<unknown> {
	return waitFor(expression, compile(expression), WAIT_DEADLINE_MS);
}

async function clickControl(
	role: string,
	name: string,
	within?: string,
): Promise<void> {
	click(await control(role, name, WAIT_DEADLINE_MS, { within }));
}

async function rightClickControl(
	role: string,
	name: string,
	within?: string,
): Promise<void> {
	rightClick(await control(role, name, WAIT_DEADLINE_MS, { within }));
}

async function typeIntoControl(
	role: string,
	name: string,
	text: string,
	within?: string,
): Promise<void> {
	const field = await control(role, name, WAIT_DEADLINE_MS, { within });
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
	) {
		throw new Error(`the ${role} named "${name}" takes no typed text`);
	}

	typeInto(field, text);
}

const actions = new Map<string, MenuAction>();
const showing = new ShowingMenu();

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
	await showing.record(async () => recorded(await this.items()));
};

for (const press of ["pointerdown", "keydown", "input"]) {
	document.addEventListener(press, () => showing.close(), { capture: true });
}

/** The menu's items as they read now, separators and the system's own items
 *  dropped, since neither is anything the app chose to offer. */
async function recorded(items: readonly unknown[]): Promise<RecordedItem[]> {
	const entries: RecordedItem[] = [];
	for (const item of items) {
		if (
			item instanceof Submenu ||
			item instanceof MenuItem ||
			item instanceof CheckMenuItem
		) {
			entries.push(await recordedItem(item));
		}
	}
	return entries;
}

async function recordedItem(
	item: Submenu | MenuItem | CheckMenuItem,
): Promise<RecordedItem> {
	return {
		id: item.id,
		label: await item.text(),
		enabled: await item.isEnabled(),
		submenu:
			item instanceof Submenu ? await recorded(await item.items()) : null,
	};
}

/** Every item of the menu the app popped up, once one is showing. */
async function menu(): Promise<readonly ShownItem[]> {
	return shownAs(await showing.next(WAIT_DEADLINE_MS));
}

/** Picks an item the way a user does, by the label they read on it and on
 *  each submenu that leads to it. */
async function choose(...path: string[]): Promise<void> {
	const item = itemAt(await showing.next(WAIT_DEADLINE_MS), path);
	const action = actions.get(item.id);
	if (!action)
		throw new Error(`the menu item labelled "${item.label}" has no action`);

	showing.close();
	action(item.id);
}

window.__trunkDrive = {
	run,
	until,
	click: clickControl,
	context: rightClickControl,
	type: typeIntoControl,
	key: pressKey,
	list: namesOf,
	menu,
	choose,
	picker: () => openPanel.next(WAIT_DEADLINE_MS),
	pick: (path) => openPanel.answer(path),
	dismissPicker: () => openPanel.dismiss(),
};
void emit(READY);
