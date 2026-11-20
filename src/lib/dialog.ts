/**
 * The native dialogs, each counted as pending work until the user answers, so
 * a restart waits for the answer and for the call it leads to. The plugin loads
 * on the first dialog rather than with the window.
 */

import { trackPending } from "./invoke.js";

type Dialog = typeof import("@tauri-apps/plugin-dialog");

const plugin = (): Promise<Dialog> => import("@tauri-apps/plugin-dialog");

/** A question's confirming button names the action it takes, and the other one is
 *  Cancel, so the answer never depends on reading the question as a yes or no. */
type Question = {
	readonly title: string;
	readonly kind: "info" | "warning";
	readonly okLabel: string;
};

export const ask = (message: string, question: Question): Promise<boolean> =>
	trackPending(
		plugin().then((dialog) =>
			dialog.ask(message, { ...question, cancelLabel: "Cancel" }),
		),
	);

export const open: Dialog["open"] = (options) =>
	trackPending(plugin().then((dialog) => dialog.open(options)));
