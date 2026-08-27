import { type TauriFake, UnknownFakeCommand } from "./index.js";

/** The system clipboard. What the application copies never leaves this object,
 *  and a test reads it back the way a user would paste it. */
export class FakeClipboard implements TauriFake {
	readonly plugin = "clipboard-manager";
	private copied: string | null = null;

	/** What the application last copied, or null while it has copied nothing. */
	get text(): string | null {
		return this.copied;
	}

	reset(): void {
		this.copied = null;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		if (command !== "write_text") {
			throw new UnknownFakeCommand(this.plugin, command);
		}
		this.copied = String(args.text);

		return null;
	}
}
