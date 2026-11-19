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
	/** The listener's registration has finished. A read made before this can
	 *  miss a change reported between the read and the registration. A failed
	 *  registration finishes too, so no reader waits on events that never come. */
	listenerSettled?(): void;
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
	}).then(
		(registeredUnlisten) => {
			if (disposed) {
				registeredUnlisten();
				return;
			}

			unlisten = registeredUnlisten;
			subscriber.listenerSettled?.();
		},
		(error: unknown) => {
			console.error("Repository change listener failed", error);
			if (!disposed) subscriber.listenerSettled?.();
		},
	);

	return () => {
		disposed = true;
		unlisten?.();
	};
}
