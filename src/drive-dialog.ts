/**
 * The dialog plugin as the drive build sees it: every function the app calls
 * is the plugin's own, except the folder picker, which waits for the agent's
 * answer in place of the native panel. rfd draws that panel at the shielding
 * window level, above every app's windows, so it would show over the user's
 * screen. vite.config.ts points the drive build's imports of the plugin here.
 */

import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { type OpenAnswer, OpenPanel } from "./drive-open-panel.js";

export * from "@tauri-apps/plugin-dialog";

export const openPanel = new OpenPanel();

export function open(options: OpenDialogOptions = {}): Promise<OpenAnswer> {
	return openPanel.ask(options);
}
