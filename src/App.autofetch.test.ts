import { setImmediate } from "node:timers";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../tests/app/harness/dom.js";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { RepositoryReadHost } from "./__tests__/helpers/repository-read-host.js";
import App from "./App.svelte";
import type { FetchReport } from "./lib/autofetch-status.js";
import { SCHEDULER } from "./lib/scheduler.js";
import { setFetchIntervalMs } from "./lib/store.js";
import { _resetToasts } from "./lib/toast.svelte.js";

const fetched: FetchReport = {
	outcome: "unchanged",
	remotes: [],
	graph_error: null,
	graph_rebuilds: 0,
};
let host: RepositoryReadHost;
let clock: FakeScheduler;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills();
	host.preferences.set("open_tabs", [
		{ id: "tab-1", repoPath: "/repo", repoName: "repo" },
	]);
	host.preferences.set("active_tab_id", "tab-1");
	host.preferences.set("fetch_interval_ms", 0);
	host.seedGraph({
		commits: [makeCommit({ oid: "restored-oid", summary: "restored commit" })],
		max_columns: 1,
		revision: 1,
	});
	host.seedResponse("git_fetch_background", fetched);
	_resetToasts();
});

afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	_resetToasts();
});

async function restoreApp() {
	const view = render(App, { context: new Map([[SCHEDULER, clock]]) });
	await screen.findAllByText("restored commit");
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Pull options" })).toBeEnabled(),
	);
	await tick();
	return view;
}

async function fetchManually(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));
	await fireEvent.click(screen.getByRole("menuitem", { name: "Fetch" }));
}

async function pickRecentRepository(name: string): Promise<void> {
	await fireEvent.keyDown(window, { key: "r", ctrlKey: true });
	const recents = await screen.findByRole("listbox", {
		name: "Recent repositories",
	});
	await fireEvent.click(within(recents).getByText(name));
}

async function settleIpcReplies(): Promise<void> {
	// Drain the Tauri window API's promise chain before driving the clock.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await tick();
}

describe("App automatic fetch coordination", () => {
	it("keeps a newer blur event when the initial focus answer arrives late", async () => {
		const releaseFocus = host.holdCommand("plugin:window|is_focused");
		await restoreApp();
		await setFetchIntervalMs(60_000);
		await host.emit("tauri://blur", null);

		releaseFocus();
		await settleIpcReplies();
		clock.advanceBy(120_000);
		await tick();
		clock.advanceBy(0);

		expect(host.count("git_fetch_background")).toBe(0);
		await host.emit("tauri://focus", null);
		await tick();
		clock.advanceBy(0);
		await waitFor(() => expect(host.count("git_fetch_background")).toBe(1));
	});

	it("releases focus listeners that finish registering after disposal", async () => {
		const releaseListeners = host.holdCommand("plugin:event|listen");
		const view = await restoreApp();
		view.unmount();

		releaseListeners();
		await settleIpcReplies();
		const focusIds = host.listenerIds("tauri://focus");
		const blurIds = host.listenerIds("tauri://blur");
		expect(focusIds).toHaveLength(1);
		expect(blurIds).toHaveLength(1);
		const releasedIds = host.requests
			.filter(({ cmd }) => cmd === "plugin:event|unlisten")
			.map(({ args }) => args.eventId);
		expect(releasedIds).toEqual(
			expect.arrayContaining([...focusIds, ...blurIds]),
		);
	});

	it("keeps the current repository open when picked again", async () => {
		host.preferences.set("recent_repos", [{ path: "/repo", name: "repo" }]);
		host.seedResponse("validate_recent_path", true);
		await restoreApp();
		const opens = host.count("open_repo");

		await pickRecentRepository("repo");
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: "Open a recent repository" }),
			).toBeNull(),
		);

		expect(host.count("close_repo")).toBe(0);
		expect(host.count("open_repo")).toBe(opens);
		expect(screen.getByText("restored commit")).toBeInTheDocument();
	});

	it("switches to an existing repository tab without replacing or closing either repository", async () => {
		host.preferences.set("open_tabs", [
			{ id: "tab-1", repoPath: "/repo", repoName: "repo" },
			{ id: "tab-2", repoPath: "/other", repoName: "other" },
		]);
		host.preferences.set("recent_repos", [{ path: "/other", name: "other" }]);
		host.seedResponse("validate_recent_path", true);
		await restoreApp();

		await pickRecentRepository("other");
		await waitFor(() =>
			expect(host.preferences.get("active_tab_id")).toBe("tab-2"),
		);

		expect(host.count("close_repo")).toBe(0);
		expect(host.preferences.get("open_tabs")).toEqual([
			{ id: "tab-1", repoPath: "/repo", repoName: "repo" },
			{ id: "tab-2", repoPath: "/other", repoName: "other" },
		]);
	});

	it("closes a replaced repository once and fences its pending automatic outcome", async () => {
		host.preferences.set("recent_repos", [{ path: "/other", name: "other" }]);
		host.seedResponse("validate_recent_path", true);
		await restoreApp();
		await setFetchIntervalMs(60_000);
		const oldCheck = host.holdNextReply("git_fetch_background");
		const nextCheck = host.holdNextReply("git_fetch_background");
		await tick();
		clock.advanceBy(60_000);
		expect(await oldCheck.entered).toEqual({
			path: "/repo",
			intervalMs: 60_000,
		});
		host.seedGraph({
			commits: [
				makeCommit({ oid: "other-oid", summary: "other repository commit" }),
			],
			max_columns: 1,
			revision: 1,
		});

		await pickRecentRepository("other");
		await screen.findByText("other repository commit");
		await waitFor(() => expect(host.count("close_repo")).toBe(1));
		expect(
			host.requests
				.filter(({ cmd }) => cmd === "close_repo")
				.map(({ args }) => args),
		).toEqual([{ path: "/repo" }]);
		clock.advanceBy(180_000);
		expect(host.count("git_fetch_background")).toBe(1);
		oldCheck.release({
			...fetched,
			outcome: "failed",
			job_error: "Obsolete repository fetch failure.",
		});
		await waitFor(() => expect(clock.pending).toBe(1));
		clock.advanceBy(0);
		expect(await nextCheck.entered).toEqual({
			path: "/other",
			intervalMs: 60_000,
		});
		expect(screen.queryByText(/Obsolete repository fetch failure/)).toBeNull();
		expect(
			host.requests
				.filter(({ cmd }) => cmd === "git_fetch_background")
				.map(({ args }) => args.path),
		).toEqual(["/repo", "/other"]);
		expect(host.count("close_repo")).toBe(1);
		nextCheck.release(fetched);
	});

	it("closes the last repository while automatic work is pending", async () => {
		await restoreApp();
		await setFetchIntervalMs(60_000);
		const automatic = host.holdNextReply("git_fetch_background");
		await tick();
		clock.advanceBy(60_000);
		await automatic.entered;

		await fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
		await waitFor(() => expect(host.count("close_repo")).toBe(1));
		expect(host.requests.find(({ cmd }) => cmd === "close_repo")?.args).toEqual(
			{
				path: "/repo",
			},
		);
		expect(screen.queryByText("restored commit")).toBeNull();
		clock.advanceBy(180_000);
		expect(host.count("git_fetch_background")).toBe(1);
		automatic.release(fetched);
	});

	it("enables a restored tab from a live preference and sends the queue interval", async () => {
		await restoreApp();
		clock.advanceBy(180_000);
		expect(host.count("git_fetch_background")).toBe(0);

		await setFetchIntervalMs(60_000);
		await tick();
		clock.advanceBy(59_999);
		expect(host.count("git_fetch_background")).toBe(0);
		clock.advanceBy(1);
		await waitFor(() => expect(host.count("git_fetch_background")).toBe(1));

		expect(
			host.requests.find(({ cmd }) => cmd === "git_fetch_background")?.args,
		).toEqual({ path: "/repo", intervalMs: 60_000 });
	});

	it("blocks automatic work during manual fetch and resets its deadline after success", async () => {
		await restoreApp();
		await setFetchIntervalMs(60_000);
		const manual = host.holdNextReply("git_fetch");
		await fetchManually();
		await manual.entered;
		await tick();

		clock.advanceBy(120_000);
		expect(host.count("git_fetch_background")).toBe(0);
		manual.release(fetched);
		await screen.findByText("Fetched successfully");
		await tick();
		clock.advanceBy(59_999);
		expect(host.count("git_fetch_background")).toBe(0);
		clock.advanceBy(1);
		await waitFor(() => expect(host.count("git_fetch_background")).toBe(1));
	});

	it("does not reset an overdue automatic deadline after manual authentication fails", async () => {
		await restoreApp();
		await setFetchIntervalMs(60_000);
		const manual = host.holdNextReply("git_fetch");
		await fetchManually();
		await manual.entered;
		await tick();
		clock.advanceBy(120_000);
		expect(host.count("git_fetch_background")).toBe(0);

		manual.reject({
			code: "authentication_failed",
			message: "Authentication failed.",
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Pull options" }),
			).toBeEnabled(),
		);
		await tick();
		clock.advanceBy(0);
		await waitFor(() => expect(host.count("git_fetch_background")).toBe(1));
		expect(screen.queryByText("Fetched successfully")).toBeNull();
	});
});
