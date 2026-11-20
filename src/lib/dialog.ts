/**
 * The native dialogs, each counted as pending work until the user answers, so
 * a restart waits for the answer and for the call it leads to. The plugin loads
 * on the first dialog rather than with the window.
 */

import { trackPending } from "./invoke.js";

type Dialog = typeof import("@tauri-apps/plugin-dialog");

const plugin = (): Promise<Dialog> => import("@tauri-apps/plugin-dialog");

export const ask: Dialog["ask"] = (message, options) =>
	trackPending(plugin().then((dialog) => dialog.ask(message, options)));

export const open: Dialog["open"] = (options) =>
	trackPending(plugin().then((dialog) => dialog.open(options)));
