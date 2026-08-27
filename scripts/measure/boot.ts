/**
 * Mounts the real application in a real browser, with `invoke` routed to the
 * host `scripts/measure/bridge.ts` runs. Same tree, same transport seam and same
 * Fakes as the application harness; the difference is that this one has layout,
 * so `getBoundingClientRect()` answers.
 */
import { mount } from "svelte";
import App from "../../src/App.svelte";
import "../../src/app.css";
import { FakeClipboard } from "../../tests/app/fakes/clipboard.js";
import { FakeDialog } from "../../tests/app/fakes/dialog.js";
import { FakeMenu } from "../../tests/app/fakes/menu.js";
import { FakeOpener } from "../../tests/app/fakes/opener.js";
import { FakePath } from "../../tests/app/fakes/path.js";
import { FakeWebview } from "../../tests/app/fakes/webview.js";
import { FakeWindow } from "../../tests/app/fakes/window.js";
import { TauriInternals } from "../../tests/app/harness/internals.js";

const BRIDGE = "http://127.0.0.1:8732";

type EventHandler = (event: string, payload: unknown) => void;

/** The two methods `TauriInternals` uses, over HTTP instead of stdio. */
class BridgeHost {
	readonly home: string;
	private readonly handlers: EventHandler[] = [];

	constructor(home: string) {
		this.home = home;
		setInterval(() => void this.drain(), 100);
	}

	async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		const response = await fetch(`${BRIDGE}/invoke`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cmd, args }),
		});
		const body = await response.json();
		if (!body.ok) throw new Error(body.error);
		return body.value;
	}

	onEvent(handler: EventHandler): void {
		this.handlers.push(handler);
	}

	private async drain(): Promise<void> {
		const batch = await fetch(`${BRIDGE}/events`).then((r) => r.json());
		for (const { event, payload } of batch)
			for (const handler of this.handlers) handler(event, payload);
	}
}

const { home } = await fetch(`${BRIDGE}/home`).then((r) => r.json());
const host = new BridgeHost(home);
const internals = new TauriInternals(host as never);
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

mount(App, { target: document.getElementById("app") as HTMLElement });
