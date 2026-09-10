import { listen } from "@tauri-apps/api/event";
import type { CoalescedTask } from "./coalesced-task.js";

/**
 * Routes repository events to one path-scoped task and owns listener teardown,
 * including registration that finishes after the owner has been disposed.
 */
export function subscribeToRepoChanges(
	repoPath: string,
	refresh: Pick<CoalescedTask, "invalidate">,
): () => void {
	let disposed = false;
	let unlisten: (() => void) | undefined;

	void listen<string>("repo-changed", (event) => {
		if (!disposed && event.payload === repoPath) refresh.invalidate();
	}).then((registeredUnlisten) => {
		if (disposed) registeredUnlisten();
		else unlisten = registeredUnlisten;
	});

	return () => {
		disposed = true;
		unlisten?.();
	};
}
