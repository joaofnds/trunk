import type { FakePath } from "../fakes/path.js";
import type { FakeWebview } from "../fakes/webview.js";
import type { FakeWindow } from "../fakes/window.js";
import type { HostClient } from "../harness/host-client.js";
import type { InvokeRecord, TauriInternals } from "../harness/internals.js";
import { delay } from "../harness/wait.js";
import { BranchesDriver } from "./branches.js";
import { EventsDriver } from "./events.js";
import { RepoDriver } from "./repo.js";
import { StagingDriver } from "./staging.js";

/**
 * `RepoView.svelte:838-847` clears and re-arms a 200 ms timer on `repo-changed`
 * and touches nothing until it fires, so the quiet window has to outlast it.
 */
const QUIET_MS = 250;
const POLL_MS = 5;
const TIMEOUT_MS = 5_000;

export interface Fakes {
	window: FakeWindow;
	webview: FakeWebview;
	path: FakePath;
}

/** The test's view of the running application: per-domain drivers and the Fakes
 *  every surface the harness does not run real is reached through. */
export class AppDriver {
	/** The tempdir this application's `app_data_dir()` resolves under. */
	readonly home: string;
	readonly repo: RepoDriver;
	readonly branches: BranchesDriver;
	readonly staging: StagingDriver;
	readonly events: EventsDriver;
	readonly window: FakeWindow;
	readonly webview: FakeWebview;
	readonly path: FakePath;

	constructor(
		private readonly host: HostClient,
		private readonly internals: TauriInternals,
		fakes: Fakes,
		repoPath: string,
	) {
		this.home = host.home;
		this.repo = new RepoDriver(repoPath);
		this.branches = new BranchesDriver();
		this.staging = new StagingDriver();
		this.events = new EventsDriver(host);
		this.window = fakes.window;
		this.webview = fakes.webview;
		this.path = fakes.path;
	}

	/** Every command the harness routed, in the order it saw them. */
	invokes(): readonly InvokeRecord[] {
		return this.internals.invokes;
	}

	/**
	 * Resolves once nothing is in flight and nothing has started for longer than
	 * the debounce. The fallback, not the default: an assertion with state to
	 * wait for should `waitFor` it and come in under this cost. Reach here only
	 * for a negative — "nothing else refetched" — which has no state to wait for.
	 */
	async settle(): Promise<void> {
		const deadline = Date.now() + TIMEOUT_MS;

		while (true) {
			const quiet = performance.now() - this.host.lastInvokeStartedAt;
			if (this.host.pendingInvokes === 0 && quiet > QUIET_MS) return;
			if (Date.now() > deadline) throw new Error("timed out settling");
			await delay(POLL_MS);
		}
	}
}
