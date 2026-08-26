import { type TauriFake, UnknownFakeCommand } from "./index.js";

const DEFAULT_ZOOM = 1;

/** Records what the application asked the webview to do; nothing it reports
 *  feeds back into the DOM, so the zoom it holds is a captured input. */
export class FakeWebview implements TauriFake {
	readonly plugin = "webview";
	private lastZoom = DEFAULT_ZOOM;

	get zoom(): number {
		return this.lastZoom;
	}

	reset(): void {
		this.lastZoom = DEFAULT_ZOOM;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		switch (command) {
			case "set_webview_zoom":
				this.lastZoom = args.value as number;
				return null;
			default:
				throw new UnknownFakeCommand(this.plugin, command);
		}
	}
}
