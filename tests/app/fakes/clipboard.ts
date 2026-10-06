import { type TauriFake, UnknownFakeCommand } from "./index.js";

/** The system clipboard. What the application copies never leaves this object,
 *  and a test reads it back the way a user would paste it. */
export class FakeClipboard implements TauriFake {
	readonly plugin = "clipboard-manager";
	private copied: string | null = null;
	private refusal: string | null = null;

	/** What the application last copied, or null while it has copied nothing. */
	get text(): string | null {
		return this.copied;
	}

	/** Every write from now on fails with `reason`, as a clipboard the system
	 *  will not let the application touch does. */
	refuseWrites(reason: string): void {
		this.refusal = reason;
	}

	reset(): void {
		this.copied = null;
		this.refusal = null;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		if (command !== "write_text") {
			throw new UnknownFakeCommand(this.plugin, command);
		}
		if (this.refusal !== null) throw this.refusal;

		this.copied = String(args.text);

		return null;
	}
}
