import { listen } from "@tauri-apps/api/event";

/** The `repo-changed` payload the backend emits (`src-tauri/src/watcher.rs`). */
export interface RepoChanged {
	repo: string;
	/** Paths relative to the repository root. Empty denotes an unscoped change;
	 * refs-only publications are delivered only to subscribers that include refs. */
	paths: string[];
	refs_only?: boolean;
	graph_revision?: number;
}

export interface RepoChangeSubscriber {
	includeRefs?: boolean;
	invalidate(event: RepoChanged): void;
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
		if (event.payload.refs_only && !subscriber.includeRefs) return;

		subscriber.invalidate(event.payload);
	}).then((registeredUnlisten) => {
		if (disposed) registeredUnlisten();
		else unlisten = registeredUnlisten;
	});

	return () => {
		disposed = true;
		unlisten?.();
	};
}
