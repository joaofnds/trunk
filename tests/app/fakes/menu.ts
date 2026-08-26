import { type TauriFake, UnknownFakeCommand } from "./index.js";

const CHANNEL_PREFIX = "__CHANNEL__:";
const SEPARATOR_KIND = "Predefined";

/**
 * The callback half of the transport seam. A menu item's action is not a
 * function the plugin holds onto: `@tauri-apps/api/menu` replaces it with a
 * `Channel`, so firing an item means dispatching a `{index, message}` envelope
 * to the callback that channel registered. A Fake that stores the function and
 * calls it fires nothing the application can see.
 */
export interface CallbackDispatch {
	runCallback(id: number, payload: unknown): void;
}

/** One item of the menu on screen, as the user reads it. */
export interface MenuEntry {
	readonly label: string;
	readonly enabled: boolean;
}

interface MenuResource {
	kind: string;
	id: string;
	text: string;
	enabled: boolean;
	items: number[];
	channel: number | null;
	fired: number;
}

/**
 * The native context menu, which never enters the DOM. Everything the menu API
 * reports is plugin state rather than JavaScript state — `isEnabled()` is an
 * `invoke`, not a field — so answering the plugin is what makes "choose the
 * item labelled Interactive Rebase..." a gesture a test can make.
 */
export class FakeMenu implements TauriFake {
	readonly plugin = "menu";
	private readonly resources = new Map<number, MenuResource>();
	private nextRid = 1;
	private showing: number | null = null;

	constructor(private readonly callbacks: CallbackDispatch) {}

	/** Every item of the menu the application popped up, separators dropped, or
	 *  an empty list while no menu is showing. */
	items(): MenuEntry[] {
		return this.showingItems().map((item) => ({
			label: item.text,
			enabled: item.enabled,
		}));
	}

	/** Picks an item the way a user does: by the label they read on it. */
	choose(label: string): void {
		const item = this.showingItems().find((entry) => entry.text === label);

		if (!item) {
			throw new Error(
				`no menu item labelled "${label}"; showing ${this.labels()}`,
			);
		}
		if (!item.enabled) {
			throw new Error(`the menu item labelled "${label}" is disabled`);
		}
		if (item.channel === null) {
			throw new Error(`the menu item labelled "${label}" carries no action`);
		}

		this.showing = null;
		this.callbacks.runCallback(item.channel, {
			index: item.fired++,
			message: item.id,
		});
	}

	reset(): void {
		this.resources.clear();
		this.nextRid = 1;
		this.showing = null;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		if (command === "new") return this.create(onTheWire(args));
		if (command === "popup") {
			this.showing = args.rid as number;
			return null;
		}

		throw new UnknownFakeCommand(this.plugin, command);
	}

	private create(wire: Record<string, unknown>): [number, string] {
		const options = (wire.options ?? {}) as Record<string, unknown>;
		const items = (options.items ?? []) as [number, string][];
		const rid = this.nextRid++;
		const id = `menu-item-${rid}`;

		this.resources.set(rid, {
			kind: wire.kind as string,
			id,
			text: (options.text as string) ?? "",
			enabled: options.enabled !== false,
			items: items.map(([itemRid]) => itemRid),
			channel: channelId(wire.handler),
			fired: 0,
		});

		return [rid, id];
	}

	private showingItems(): MenuResource[] {
		const menu =
			this.showing === null ? undefined : this.resources.get(this.showing);
		if (!menu) return [];

		return menu.items
			.map((rid) => this.resources.get(rid))
			.filter((item): item is MenuResource => item !== undefined)
			.filter((item) => item.kind !== SEPARATOR_KIND);
	}

	private labels(): string {
		const labels = this.items().map((entry) => entry.label);
		return labels.length === 0 ? "no menu" : labels.join(", ");
	}
}

/**
 * What the plugin would receive over the IPC boundary. The seam hands a Fake the
 * argument object itself, so a `Channel` arrives live; serializing it here is
 * what turns it into the `__CHANNEL__:<id>` reference the plugin is written
 * against.
 */
function onTheWire(args: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}

function channelId(handler: unknown): number | null {
	if (typeof handler !== "string") return null;
	if (!handler.startsWith(CHANNEL_PREFIX)) return null;

	return Number(handler.slice(CHANNEL_PREFIX.length));
}
