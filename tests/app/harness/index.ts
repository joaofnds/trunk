import { mount, unmount } from "svelte";
import App from "../../../src/App.svelte";
import { startAppServices } from "../../../src/lib/app-services.js";
import { AppDriver } from "../drivers/index.js";
import { FakeClipboard } from "../fakes/clipboard.js";
import { FakeDialog } from "../fakes/dialog.js";
import { FakeMenu } from "../fakes/menu.js";
import { FakeOpener } from "../fakes/opener.js";
import { FakePath } from "../fakes/path.js";
import { FakeWebview } from "../fakes/webview.js";
import { FakeWindow } from "../fakes/window.js";
import { installDomPolyfills, restoreDomPolyfills } from "./dom.js";
import { HostClient, type RepoSpec } from "./host-client.js";
import { TauriInternals } from "./internals.js";

export type { RepoSpec, SpecStep } from "./host-client.js";

export interface SetupOptions {
	repo?: RepoSpec;
	/** The scroll viewport's height, for a test that needs a list shorter than
	 *  its own content so it scrolls and culls. Defaults to a viewport tall
	 *  enough that nothing does. */
	viewportHeight?: number;
}

interface Running {
	host: HostClient;
	internals: TauriInternals;
	root: HTMLElement;
	app: Record<string, unknown>;
	untrackScroll: () => void;
}

let running: Running | null = null;

/**
 * Boots the real application headlessly: a fresh host process, a seeded
 * repository, the transport seam installed before anything imports it, and the
 * same root `src/main.ts` mounts, started via `startAppServices()`.
 *
 * One host process is one application is one test, so every managed state and
 * the resolved `app_data_dir` isolate without a reset step.
 */
export async function setup(options: SetupOptions = {}): Promise<AppDriver> {
	if (running)
		throw new Error("an application is already running; teardown first");

	const host = await HostClient.spawn();
	const repoPath = options.repo ? await host.seedRepo(options.repo) : "";
	if (repoPath) await offerInRecents(host, repoPath);

	const internals = new TauriInternals(host);
	const fakes = {
		window: new FakeWindow(),
		webview: new FakeWebview(),
		path: new FakePath(host.home),
		menu: new FakeMenu(internals),
		dialog: new FakeDialog(),
		clipboard: new FakeClipboard(),
		opener: new FakeOpener(),
	};
	internals.route(Object.values(fakes));

	installDomPolyfills({ viewportHeight: options.viewportHeight });
	internals.install();

	const root = document.createElement("div");
	document.body.appendChild(root);
	const untrackScroll = startAppServices();
	const app = mount(App, { target: root });

	running = { host, internals, root, app, untrackScroll };
	return new AppDriver(host, internals, fakes, repoPath);
}

/** Unmounts the application, reaps the host process and removes its tempdir
 *  `HOME`. A leaked host holds a tempdir open, which is a defect, not untidiness. */
export async function teardown(): Promise<void> {
	if (!running) return;

	const { host, internals, root, app, untrackScroll } = running;
	running = null;

	await unmount(app);
	untrackScroll();
	root.remove();
	internals.uninstall();
	restoreDomPolyfills();
	await host.shutdown();
}

/** Puts the seeded repository where the welcome screen offers it, so the test's
 *  own act is the click rather than the arrangement. */
async function offerInRecents(host: HostClient, path: string): Promise<void> {
	await host.invoke("prefs_set", {
		key: "recent_repos",
		value: [{ name: path.split("/").at(-1), path }],
	});
}
