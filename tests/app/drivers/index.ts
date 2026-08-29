import type { FakeClipboard } from "../fakes/clipboard.js";
import type { FakeDialog } from "../fakes/dialog.js";
import type { FakeMenu } from "../fakes/menu.js";
import type { FakeOpener } from "../fakes/opener.js";
import type { FakePath } from "../fakes/path.js";
import type { FakeWebview } from "../fakes/webview.js";
import type { FakeWindow } from "../fakes/window.js";
import type { HostClient } from "../harness/host-client.js";
import type { InvokeRecord, TauriInternals } from "../harness/internals.js";
import { waitFor } from "../harness/wait.js";
import { BranchesDriver } from "./branches.js";
import { EventsDriver } from "./events.js";
import { RebaseEditorDriver } from "./rebase-editor.js";
import { RemoteDriver } from "./remote.js";
import { RepoDriver } from "./repo.js";
import { ReviewDriver } from "./review.js";
import { StagingDriver } from "./staging.js";

/**
 * `RepoView.svelte:838-847` clears and re-arms a 200 ms timer on `repo-changed`
 * and touches nothing until it fires, so the quiet window has to outlast it.
 */
const QUIET_MS = 250;

const TOAST = '[role="status"]';

export interface Fakes {
	window: FakeWindow;
	webview: FakeWebview;
	path: FakePath;
	menu: FakeMenu;
	dialog: FakeDialog;
	clipboard: FakeClipboard;
	opener: FakeOpener;
}

/** The test's view of the running application: per-domain drivers and the Fakes
 *  every surface the harness does not run real is reached through. */
export class AppDriver {
	/** The tempdir this application's `app_data_dir()` resolves under. */
	readonly home: string;
	readonly repo: RepoDriver;
	readonly branches: BranchesDriver;
	readonly staging: StagingDriver;
	readonly remote: RemoteDriver;
	readonly review: ReviewDriver;
	readonly rebaseEditor: RebaseEditorDriver;
	readonly events: EventsDriver;
	readonly contextMenu: FakeMenu;
	readonly dialog: FakeDialog;
	readonly clipboard: FakeClipboard;
	readonly opener: FakeOpener;
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
		this.repo = new RepoDriver(repoPath, fakes.menu);
		this.branches = new BranchesDriver(fakes.menu);
		this.staging = new StagingDriver();
		this.remote = new RemoteDriver();
		this.review = new ReviewDriver();
		this.rebaseEditor = new RebaseEditorDriver();
		this.events = new EventsDriver(host, internals);
		this.contextMenu = fakes.menu;
		this.dialog = fakes.dialog;
		this.clipboard = fakes.clipboard;
		this.opener = fakes.opener;
		this.window = fakes.window;
		this.webview = fakes.webview;
		this.path = fakes.path;
	}

	/** Everything the application is telling the user right now, oldest first. */
	toasts(): string[] {
		const showing = document.querySelectorAll<HTMLElement>(TOAST);

		return [...showing].map((toast) => toast.textContent?.trim() ?? "");
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
		await waitFor("a quiet window", () => {
			const quiet = performance.now() - this.host.lastInvokeStartedAt;
			return this.host.pendingInvokes === 0 && quiet > QUIET_MS ? true : null;
		});
	}
}
