import { type TauriFake, UnknownFakeCommand } from "./index.js";

/** The hand-off to the operating system. Nothing here reaches a browser; the
 *  Fake records what the application asked the OS to open. */
export class FakeOpener implements TauriFake {
	readonly plugin = "opener";
	private readonly urls: string[] = [];

	/** Every URL the application asked the system to open, oldest first. */
	get opened(): readonly string[] {
		return this.urls;
	}

	reset(): void {
		this.urls.length = 0;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		if (command !== "open_url") {
			throw new UnknownFakeCommand(this.plugin, command);
		}
		this.urls.push(String(args.url));

		return null;
	}
}
