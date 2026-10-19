import { type TauriFake, UnknownFakeCommand } from "./index.js";

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
 * label rather than a boolean. Custom labels reach the plugin as
 * `{ OkCancelCustom: [ok, cancel] }` or `{ OkCustom: ok }`.
 */
function okLabelOf(buttons: unknown): string {
	if (typeof buttons !== "object" || buttons === null) return DEFAULT_OK;
	if ("OkCancelCustom" in buttons && Array.isArray(buttons.OkCancelCustom)) {
		return String(buttons.OkCancelCustom[0]);
	}
	if ("OkCustom" in buttons) return String(buttons.OkCustom);

	return DEFAULT_OK;
}
