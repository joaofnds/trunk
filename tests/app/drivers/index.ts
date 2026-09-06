import { tick } from "svelte";
import type { FakeClipboard } from "../fakes/clipboard.js";
import type { FakeDialog } from "../fakes/dialog.js";
import type { FakeMenu } from "../fakes/menu.js";
import type { FakeOpener } from "../fakes/opener.js";
import type { FakePath } from "../fakes/path.js";
import type { FakeScheduler } from "../fakes/scheduler.js";
import type { FakeWebview } from "../fakes/webview.js";
import type { FakeWindow } from "../fakes/window.js";
import type { HostClient } from "../harness/host-client.js";
import type { InvokeRecord, TauriInternals } from "../harness/internals.js";
import { waitFor } from "../harness/wait.js";
import { BranchesDriver } from "./branches.js";
import { DiffPaneDriver } from "./diff-pane.js";
import { EventsDriver } from "./events.js";
import { MergeEditorDriver } from "./merge-editor.js";
import { MessageEditorDriver } from "./message-editor.js";
import { RebaseEditorDriver } from "./rebase-editor.js";
import { RemoteDriver } from "./remote.js";
import { RepoDriver } from "./repo.js";
import { ReviewDriver } from "./review.js";
import { SearchDriver } from "./search.js";
import { StagingDriver } from "./staging.js";
import { ToolbarDriver } from "./toolbar.js";

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
	readonly toolbar: ToolbarDriver;
	readonly messageEditor: MessageEditorDriver;
	readonly diffPane: DiffPaneDriver;
	readonly mergeEditor: MergeEditorDriver;
	readonly search: SearchDriver;
	readonly events: EventsDriver;
	readonly contextMenu: FakeMenu;
	readonly dialog: FakeDialog;
	readonly clipboard: FakeClipboard;
	readonly opener: FakeOpener;
	readonly window: FakeWindow;
	readonly webview: FakeWebview;
	readonly path: FakePath;
	/** The application's timers, frozen. A debounced refresh runs only when a
	 *  test fires them. */
	readonly scheduler: FakeScheduler;

	constructor(
		private readonly host: HostClient,
		private readonly internals: TauriInternals,
		fakes: Fakes,
		scheduler: FakeScheduler,
		repoPath: string,
	) {
		this.home = host.home;
		this.repo = new RepoDriver(repoPath, fakes.menu);
		this.branches = new BranchesDriver(fakes.menu);
		this.staging = new StagingDriver(fakes.menu);
		this.remote = new RemoteDriver();
		this.review = new ReviewDriver();
		this.rebaseEditor = new RebaseEditorDriver();
		this.toolbar = new ToolbarDriver();
		this.messageEditor = new MessageEditorDriver();
		this.diffPane = new DiffPaneDriver();
		this.mergeEditor = new MergeEditorDriver();
		this.search = new SearchDriver();
		this.events = new EventsDriver(host, internals);
		this.contextMenu = fakes.menu;
		this.dialog = fakes.dialog;
		this.clipboard = fakes.clipboard;
		this.opener = fakes.opener;
		this.window = fakes.window;
		this.webview = fakes.webview;
		this.path = fakes.path;
		this.scheduler = scheduler;
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

	/** Writes a pref directly to the host, the way the application's own
	 *  `prefs_set` would, so a test can arrange stored state (e.g. a persisted
	 *  hidden-ref set) before the gesture that reads it back. */
	async seedPref(key: string, value: unknown): Promise<void> {
		await this.host.invoke("prefs_set", { key, value });
	}

	/** Freezes every read of the named pref before it reaches the host, so a test
	 *  can inspect a render from between two mount effects that race to resolve.
	 *  Returns the release. */
	holdPrefsGet(key: string): () => void {
		return this.internals.holdPrefsGet(key);
	}

	/** How many times the application has refetched the commit graph. What a
	 *  debounced refresh is observable as when the graph it produces is
	 *  unchanged. */
	refreshes(): number {
		return this.internals.invokes.filter(
			({ cmd }) => cmd === "refresh_commit_graph",
		).length;
	}

	/**
	 * Runs the application's debounced work: waits for a timer to be armed, then
	 * fires it. What the debounce goes on to do is still asynchronous, so the
	 * assertion after this waits on the state it expects.
	 */
	async elapse(): Promise<void> {
		await waitFor("a timer to be armed", () =>
			this.scheduler.pending > 0 ? true : null,
		);

		this.scheduler.flush();
	}

	/**
	 * Waits for `condition`, firing the application's timers as they arm. One
	 * user action can produce several `repo-changed` emits, each arming the
	 * debounce again; the test asserts on the state it wants rather than
	 * counting emits it does not control.
	 */
	async elapseUntil<T>(description: string, condition: () => T | null) {
		return waitFor(description, () => {
			const value = condition();
			if (value !== null) return value;
			this.scheduler.flush();

			return null;
		});
	}

	/**
	 * Runs every debounced refresh to completion, so the next gesture acts on a
	 * view that will not re-render under it. A refresh that lands mid-gesture
	 * discards a selection the test had just made.
	 *
	 * Quiet has to hold twice, either side of a Svelte flush. The debounce
	 * callback only bumps a signal; the invoke it leads to is issued from an
	 * effect a microtask later, so a single sample can see no timer and no
	 * invoke while a refresh is already on its way.
	 */
	async settled(): Promise<void> {
		for (;;) {
			await this.elapseUntil("the application's timers to run out", () =>
				this.quiet() ? true : null,
			);
			await tick();
			if (this.quiet()) return;
		}
	}

	/**
	 * Scrolls the commit graph to the end of history, the way a user does: to the
	 * bottom, let what that asks for arrive, and again, until a scroll to the
	 * bottom brings back nothing new.
	 *
	 * The graph pages as the viewport reaches the end of the rows it holds, so
	 * reaching the oldest commit takes as many gestures as the history has pages,
	 * and a test cannot know that number. Letting each page arrive is what
	 * `settled()` does, and skipping it reads the depth from before the request:
	 * a working pager then looks stalled.
	 */
	async scrollToOldest(): Promise<void> {
		let previous = -1;

		while (this.repo.loadedDepth() > previous) {
			previous = this.repo.loadedDepth();
			await this.repo.scrollToTail();
			await this.settled();
		}
	}

	/** Nothing armed and nothing in flight, as of this instant. */
	private quiet(): boolean {
		return this.scheduler.pending === 0 && this.host.pendingInvokes === 0;
	}
}
