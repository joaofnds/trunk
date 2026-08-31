import { waitFor } from "../harness/wait.js";

const BACKDROP = '[data-testid="message-editor-backdrop"]';

/** The host-owned commit message modal: revert, cherry-pick and merge continue
 *  all route their message through this one dialog. */
export class MessageEditorDriver {
	/** The message the editor opened with, before the user touches it. */
	async text(): Promise<string> {
		const dialog = await this.dialog();

		return dialog.querySelector("textarea")?.value ?? "";
	}

	/** Saves the message as offered. */
	async save(): Promise<void> {
		const dialog = await this.dialog();
		const button = [...dialog.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Save",
		);
		if (!button) throw new Error("the message editor offers no Save");

		button.click();
	}

	private dialog(): Promise<HTMLElement> {
		return waitFor("the message editor", () =>
			document.querySelector<HTMLElement>(BACKDROP),
		);
	}
}
