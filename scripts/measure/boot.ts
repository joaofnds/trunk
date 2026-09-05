/**
 * Mounts the real application in a real browser, with `invoke` routed to the
 * host `scripts/measure/bridge.ts` runs. Same tree, same transport seam and same
 * Fakes as the application harness; the difference is that this one has layout,
 * so `getBoundingClientRect()` answers.
 *
 * The bridge is reached through Vite's `/bridge` proxy, so the page is
 * same-origin with it, and every request carries the run's token — which the
 * page can read only because Vite serves it from the bridge's own directory.
 */
import { mount } from "svelte";
import App from "../../src/App.svelte";
import "../../src/app.css";
import { startAppServices } from "../../src/lib/app-services.js";
import { FakeClipboard } from "../../tests/app/fakes/clipboard.js";
import { FakeDialog } from "../../tests/app/fakes/dialog.js";
import { FakeMenu } from "../../tests/app/fakes/menu.js";
import { FakeOpener } from "../../tests/app/fakes/opener.js";
import { FakePath } from "../../tests/app/fakes/path.js";
import { FakeWebview } from "../../tests/app/fakes/webview.js";
import { FakeWindow } from "../../tests/app/fakes/window.js";
import {
	type HostChannel,
	TauriInternals,
} from "../../tests/app/harness/internals.js";
import rawToken from "./.bridge-token.txt?raw";
import type { BridgeContext, BridgeEvent } from "./router.js";

const BRIDGE = "/bridge";
const DRAIN_INTERVAL = 100;

type EventHandler = (event: string, payload: unknown) => void;

interface InvokeReply {
	ok: boolean;
	value?: unknown;
	error?: string;
}

/** The two methods `TauriInternals` uses, over HTTP instead of stdio. */
class BridgeHost implements HostChannel {
	private readonly handlers: EventHandler[] = [];

	constructor(private readonly token: string) {
		void this.pump();
	}

	async invoke<T>(
		cmd: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		const response = await fetch(`${BRIDGE}/invoke`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-bridge-token": this.token,
			},
			body: JSON.stringify({ cmd, args }),
		});
		const body: InvokeReply = await response.json();
		if (!body.ok) throw new Error(body.error);

		onReply?.(body.value as T);
		return body.value as T;
	}

	onEvent(handler: EventHandler): void {
		this.handlers.push(handler);
	}

	/** Self-chaining rather than an interval: `/events` is destructive on the
	 *  bridge, so two drains in flight at once would each take a distinct slice
	 *  and deliver them out of order. */
	private async pump(): Promise<void> {
		for (;;) {
			try {
				await this.drain();
			} catch (error) {
				console.error("bridge drain failed", error);
			}
			await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL));
		}
	}

	private async drain(): Promise<void> {
		const response = await fetch(`${BRIDGE}/events`, {
			headers: { "x-bridge-token": this.token },
		});
		const batch: BridgeEvent[] = await response.json();
		for (const { event, payload } of batch)
			for (const handler of this.handlers) handler(event, payload);
	}
}

/* Vite serves this directory as modules, so the token is read with ?raw — a
   plain-text import — rather than fetched, which would come back transformed
   into a module with a sourcemap comment appended. */
const token = rawToken.trim();
const { home }: BridgeContext = await fetch(`${BRIDGE}/home`, {
	headers: { "x-bridge-token": token },
}).then((r) => r.json());

const host = new BridgeHost(token);
const internals = new TauriInternals(host);
internals.route([
	new FakeWindow(),
	new FakeWebview(),
	new FakePath(home),
	new FakeMenu(internals),
	new FakeDialog(),
	new FakeClipboard(),
	new FakeOpener(),
]);
internals.install();

startAppServices();

mount(App, { target: document.getElementById("app") as HTMLElement });
