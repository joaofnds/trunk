import { listen } from "@tauri-apps/api/event";

/** The `repo-changed` payload the backend emits (`src-tauri/src/watcher.rs`). */
export interface RepoChanged {
	repo: string;
	/** Paths relative to the repository root. Empty denotes an unscoped change;
	 * refs-only publications are delivered only to subscribers that include refs. */
	paths: string[];
	refs_only?: boolean;
	graph_revision?: number;
	command_completed?: boolean;
}

export interface RepoChangeSubscriber {
	includeRefs?: boolean;
	invalidate(event: RepoChanged): void;
	run?(): Promise<void>;
}

/** Completed commands bypass the watcher deadline, including an already busy reader. */
export function requestRepoChange(
	subscriber: RepoChangeSubscriber,
	event: RepoChanged,
): void {
	if (event.command_completed && subscriber.run) {
		void subscriber
			.run()
			.catch((error: unknown) =>
				console.error("Repository refresh failed", error),
			);
	} else subscriber.invalidate(event);
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

		requestRepoChange(subscriber, event.payload);
	}).then((registeredUnlisten) => {
		if (disposed) registeredUnlisten();
		else unlisten = registeredUnlisten;
	});

	return () => {
		disposed = true;
		unlisten?.();
	};
}
