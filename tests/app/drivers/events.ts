import type { HostClient } from "../harness/host-client.js";

/**
 * Events the application would otherwise receive from the outside world. The
 * filesystem watcher is off in the harness, so the external-change gesture is
 * the host making the identical `app.emit("repo-changed", path)` call that
 * `src-tauri/src/watcher.rs:24` makes: indistinguishable downstream.
 */
export class EventsDriver {
	constructor(private readonly host: HostClient) {}

	async externalChange(path: string): Promise<void> {
		await this.host.emit("repo-changed", path);
	}

	/** How many filesystem watches the application holds. */
	watchers(): Promise<number> {
		return this.host.watcherCount();
	}
}
