import { listen } from "@tauri-apps/api/event";

/** The `repo-changed` payload the backend emits (`src-tauri/src/watcher.rs`). */
export interface RepoChanged {
	repo: string;
	/** The files the change touched, relative to the repository root. Empty when
	 *  the writer could not name them, which every subscriber treats as a change
	 *  it must refresh for. */
	paths: string[];
}

/** Notified of a change to the repository it was subscribed for.
 *
 *  `changed` names the files the change touched, and is empty when the writer
 *  could not name them. A subscriber whose work depends on particular files
 *  reads it to skip a write that concerns none of them; one that reads the whole
 *  repository ignores it (TRUNK-232). */
export interface RepoChangeSubscriber {
	invalidate(changed: readonly string[]): void;
}

/**
 * Routes repository events to one path-scoped subscriber and owns listener
 * teardown, including registration that finishes after the owner has been
 * disposed.
 */
export function subscribeToRepoChanges(
	repoPath: string,
	subscriber: RepoChangeSubscriber,
): () => void {
	let disposed = false;
	let unlisten: (() => void) | undefined;

	void listen<RepoChanged>("repo-changed", (event) => {
		if (disposed || event.payload.repo !== repoPath) return;

		subscriber.invalidate(event.payload.paths);
	}).then((registeredUnlisten) => {
		if (disposed) registeredUnlisten();
		else unlisten = registeredUnlisten;
	});

	return () => {
		disposed = true;
		unlisten?.();
	};
}
