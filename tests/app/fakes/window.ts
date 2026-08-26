import { type TauriFake, UnknownFakeCommand } from "./index.js";

/** The window state a real `Window` reports, with the OS taken out of it. */
export class FakeWindow implements TauriFake {
	readonly plugin = "window";
	private fullscreen = false;
	private focused = true;

	enterFullscreen(): void {
		this.fullscreen = true;
	}

	leaveFullscreen(): void {
		this.fullscreen = false;
	}

	focus(): void {
		this.focused = true;
	}

	blur(): void {
		this.focused = false;
	}

	reset(): void {
		this.fullscreen = false;
		this.focused = true;
	}

	answer(command: string): unknown {
		switch (command) {
			case "is_fullscreen":
				return this.fullscreen;
			case "is_focused":
				return this.focused;
			default:
				throw new UnknownFakeCommand(this.plugin, command);
		}
	}
}
