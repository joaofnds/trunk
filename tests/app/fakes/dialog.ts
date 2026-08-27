import { type TauriFake, UnknownFakeCommand } from "./index.js";

const YES_NO = "YesNo";
const DEFAULT_OK = "Yes";
const DISMISSED = "";

/** The native dialogs: the question the user answers before a destructive
 *  action, the message they acknowledge, and the folder they pick.
 *
 *  A dismissed question is the default, so a test that never says otherwise
 *  cannot silently confirm a branch deletion or a rebase abort. */
export class FakeDialog implements TauriFake {
	readonly plugin = "dialog";
	private readonly messages: string[] = [];
	private confirming = false;
	private chosen: string | null = null;

	/** Every message the application has put in front of the user, oldest first. */
	get shown(): readonly string[] {
		return this.messages;
	}

	/** The next question is answered with its confirming button. */
	confirms(): void {
		this.confirming = true;
	}

	dismisses(): void {
		this.confirming = false;
	}

	/** The next file dialog returns this path. */
	chooses(path: string): void {
		this.chosen = path;
	}

	reset(): void {
		this.messages.length = 0;
		this.confirming = false;
		this.chosen = null;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		switch (command) {
			case "message":
				this.messages.push(String(args.message));
				return this.confirming ? okLabelOf(args.buttons) : DISMISSED;
			case "open":
				return this.chosen;
			default:
				throw new UnknownFakeCommand(this.plugin, command);
		}
	}
}

/**
 * `ask()` reports the button the user pressed by comparing the plugin's answer
 * against the label it asked for, so confirming means returning that exact
 * label rather than a boolean.
 */
function okLabelOf(buttons: unknown): string {
	if (buttons === YES_NO || buttons === undefined) return DEFAULT_OK;
	if (typeof buttons === "object" && buttons !== null && "ok" in buttons) {
		return String((buttons as { ok: unknown }).ok);
	}

	return DEFAULT_OK;
}
