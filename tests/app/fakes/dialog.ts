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
	private readonly asked: string[] = [];
	private confirming = false;
	private chosen: string | null = null;
	private whileOpen: ((question: string) => void) | null = null;

	/** Every message the application has put in front of the user, oldest first. */
	get shown(): readonly string[] {
		return this.messages;
	}

	/** The messages that offered a choice, oldest first. The rest could only be
	 *  acknowledged. */
	get questions(): readonly string[] {
		return this.asked;
	}

	/** The next question is answered with its confirming button. */
	confirms(): void {
		this.confirming = true;
	}

	dismisses(): void {
		this.confirming = false;
	}

	/** Runs `effect` while the next question is open, before it is answered, as a
	 *  user who changes something in another window before clicking would. */
	whileAsking(effect: (question: string) => void): void {
		this.whileOpen = effect;
	}

	/** The next file dialog returns this path. */
	chooses(path: string): void {
		this.chosen = path;
	}

	reset(): void {
		this.messages.length = 0;
		this.asked.length = 0;
		this.confirming = false;
		this.chosen = null;
		this.whileOpen = null;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		switch (command) {
			case "message": {
				const question = String(args.message);
				this.messages.push(question);
				if (offersAChoice(args.buttons)) this.asked.push(question);
				const effect = this.whileOpen;
				this.whileOpen = null;
				effect?.(question);

				return this.confirming ? okLabelOf(args.buttons) : DISMISSED;
			}
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

/** `message()` sends no buttons, or one OK button, and `ask()` and `confirm()` send
 *  a pair. */
function offersAChoice(buttons: unknown): boolean {
	if (typeof buttons === "string") return buttons !== "Ok";
	if (typeof buttons !== "object" || buttons === null) return false;

	return "OkCancelCustom" in buttons || "YesNoCancelCustom" in buttons;
}
