import type { HostClient } from "../harness/host-client.js";
import type { TauriInternals } from "../harness/internals.js";

/**
 * Events the application would otherwise receive from the outside world. The
 * filesystem watcher is off in the harness, so the external-change gesture is
 * the host making the identical `app.emit("repo-changed", path)` call that
 * `src-tauri/src/watcher.rs:45` makes: indistinguishable downstream.
 */
export class EventsDriver {
	constructor(
		private readonly host: HostClient,
		private readonly internals: TauriInternals,
	) {}

	/** One emit, so it waits until the application is listening. The watcher this
	 *  stands in for emits over and over and can afford to lose the first. */
	async externalChange(path: string): Promise<void> {
		await this.internals.registrationsSettled();
		await this.host.emit("repo-changed", path);
	}

	/** How many filesystem watches the application holds. */
	watchers(): Promise<number> {
		return this.host.watcherCount();
	}
}
