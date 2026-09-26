/**
 * Mounts the real application in the suite's browser, with `invoke` carried to
 * the host by the bindings `tests/visual/harness.ts` exposes on the page. The
 * host never listens on a port, so nothing but this page can reach its command
 * set, the destructive commands included.
 */
import { mount } from "svelte";
import App from "../../../src/App.svelte";
import "../../../src/app.css";
import { startAppServices } from "../../../src/lib/app-services.js";
import { FakeClipboard } from "../../app/fakes/clipboard.js";
import { FakeDialog } from "../../app/fakes/dialog.js";
import { FakeMenu } from "../../app/fakes/menu.js";
import { FakeOpener } from "../../app/fakes/opener.js";
import { FakePath } from "../../app/fakes/path.js";
import { FakeWebview } from "../../app/fakes/webview.js";
import { FakeWindow } from "../../app/fakes/window.js";
import {
	type HostChannel,
	TauriInternals,
} from "../../app/harness/internals.js";
import "./bindings.js";

type EventHandler = (event: string, payload: unknown) => void;

class BindingHost implements HostChannel {
	async invoke<T>(
		cmd: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		window.__trunkPending += 1;
		try {
			const value = (await window.__trunkInvoke(cmd, args)) as T;

			onReply?.(value);
			return value;
		} finally {
			window.__trunkPending -= 1;
		}
	}

	onEvent(handler: EventHandler): void {
		window.__trunkOnEvent(handler);
	}
}

const internals = new TauriInternals(new BindingHost());
internals.route([
	new FakeWindow(),
	new FakeWebview(),
	new FakePath(await window.__trunkHome()),
	new FakeMenu(internals),
	new FakeDialog(),
	new FakeClipboard(),
	new FakeOpener(),
]);
internals.install();

startAppServices();

mount(App, { target: document.getElementById("app") as HTMLElement });
