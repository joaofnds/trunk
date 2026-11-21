import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import { REPO_CHANGE_DELAY_MS } from "./lib/coalesced-task.js";
import { _resetToasts, toasts } from "./lib/toast.svelte.js";

const savedTabs = [
	{ id: "first", repoPath: "/first", repoName: "first" },
	{ id: "active", repoPath: "/active", repoName: "active" },
	{ id: "last", repoPath: "/last", repoName: "last" },
];
let app: StartupHarness;
afterEach(() => {
	app?.teardown();
	_resetToasts();
});

describe("App startup", () => {
	it("keeps a requested new tab selected when saved tabs finish restoring", async () => {
		app = new StartupHarness(savedTabs, "active");
		const restore = app.host.holdNextReply("prefs_open_tabs");
		app.start();
		await restore.entered;

		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		restore.release({ writer: 1, tabs: savedTabs, activeTabId: "active" });
		await app.settle();

		const selected = screen.getByRole("tab", {
			name: "New Tab",
			selected: true,
		});
		expect(app.host.preferences.get("open_tabs")).toEqual([
			...savedTabs,
			expect.objectContaining({ repoPath: null, repoName: "New Tab" }),
		]);
		expect(selected.closest("[data-tab-id]")?.getAttribute("data-tab-id")).toBe(
			app.host.preferences.get("active_tab_id"),
		);
	});

	it("retries a failed tab read and restores the valid choices from a malformed list", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.host.preferences.set("open_tabs", [null, ...savedTabs, { id: "bad" }]);
		app.host.seedResponse("updates_status", { phase: "manual" });
		const read = app.host.holdNextReply("prefs_open_tabs");
		app.start();
		await read.entered;
		read.reject({ code: "io", message: "Temporarily unavailable" });

		await fireEvent.click(
			await screen.findByRole("button", { name: "Retry opening tabs" }),
		);
		await screen.findByText("restored history");
		await app.settle();

		const restored = within(
			screen.getByRole("tablist", { name: "Repository tabs" }),
		);
		expect(
			restored.getAllByRole("tab").map((tab) => tab.textContent?.trim()),
		).toEqual(["first", "active", "last"]);
		expect(
			restored.getByRole("tab", { selected: true }).textContent?.trim(),
		).toBe("active");
		expect(app.host.count("updates_ready")).toBe(1);
	});

	it("keeps the legacy repository preference when its replacement cannot be saved", async () => {
		const legacy = { path: "/legacy", name: "legacy" };
		app = new StartupHarness([], "missing");
		app.host.preferences.set("open_repo", legacy);
		const migration = app.host.holdNextReply("prefs_set_tabs");
		app.start();
		await migration.entered;

		migration.reject({ code: "io", message: "Disk full" });
		await screen.findByText("restored history");

		expect(
			screen.getByRole("tab", { name: "legacy", selected: true }),
		).toBeInTheDocument();
		expect(app.host.preferences.get("open_repo")).toEqual(legacy);
		expect(app.host.preferences.get("open_tabs")).toEqual([]);
	});

	it("keeps a malformed legacy repository and opens a blank tab", async () => {
		const malformed = { path: 42, name: "legacy" };
		app = new StartupHarness([], "missing");
		app.host.preferences.set("open_repo", malformed);

		app.start();
		await app.settle();

		expect(app.host.preferences.get("open_repo")).toEqual(malformed);
		expect(app.host.preferences.get("open_tabs")).toEqual([
			expect.objectContaining({ repoPath: null, repoName: "New Tab" }),
		]);
		expect(
			screen.getByRole("tab", { name: "New Tab", selected: true }),
		).toBeInTheDocument();
	});

	it("reads initial refs and dirty counts once for the visible repository", async () => {
		app = new StartupHarness(savedTabs, "active");

		app.start();
		await screen.findByText("restored history");
		await app.settle();

		expect(app.paths("list_refs")).toEqual(["/active"]);
		expect(app.paths("get_dirty_counts")).toEqual(["/active"]);
	});

	it("warns that an unwatched repository will not show changes made outside Trunk", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		await app.host.emit("watch-unavailable", { repo: "/repos/opening" });

		await waitFor(() =>
			expect(toasts.items).toContainEqual(
				expect.objectContaining({
					message:
						"Changes made outside Trunk won't show in opening until you close it and open it again.",
					kind: "error",
				}),
			),
		);
	});

	it("keeps dirty badges current for prepared tabs before their views mount", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		app.host.seedResponse("get_dirty_counts", {
			staged: 0,
			unstaged: 1,
			conflicted: 0,
		});

		app.clock.advanceBy(0);
		await app.settle();
		expect(app.dirty("first")).toBe(true);
		app.host.seedResponse("get_dirty_counts", {
			staged: 0,
			unstaged: 0,
			conflicted: 0,
		});
		await app.host.emitRepoChanged({ repo: "/first", paths: ["file.txt"] });
		app.clock.advanceBy(200);
		await app.settle();

		expect(app.dirty("first")).toBe(false);
		expect(app.paths("get_commit_graph")).toEqual(["/active"]);
	});

	it("bounds dirty-count refreshes for a prepared tab that has never been selected", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await app.prepareNextRepository();
		await app.prepareNextRepository();
		const before = app.paths("get_dirty_counts").length;
		const read = app.host.holdNextReply("get_dirty_counts");
		const event = { repo: "/first", paths: ["file.txt"] };

		await app.host.emitRepoChanged(event);
		app.clock.advanceBy(REPO_CHANGE_DELAY_MS);
		expect(await read.entered).toEqual({ path: "/first" });
		for (let i = 0; i < 9; i += 1) {
			await app.host.emitRepoChanged(event);
			app.clock.advanceBy(REPO_CHANGE_DELAY_MS);
		}
		expect(app.paths("get_dirty_counts")).toHaveLength(before + 1);
		app.host.seedResponse("get_dirty_counts", { staged: 0, unstaged: 1 });
		read.release({ staged: 0, unstaged: 0 });
		await app.settle();
		app.clock.advanceBy(REPO_CHANGE_DELAY_MS);
		await waitFor(() => expect(app.dirty("first")).toBe(true));

		expect(app.paths("get_dirty_counts")).toHaveLength(before + 2);
		expect(app.paths("get_commit_graph")).toEqual(["/active"]);
	});

	it.each([false, true])(
		"updates a completed command's prepared-tab badge without a timer (busy=%s)",
		async (busy) => {
			app = new StartupHarness(savedTabs, "active");
			app.start();
			await screen.findByText("restored history");
			await app.settle();
			await app.prepareNextRepository();
			await app.prepareNextRepository();
			const before = app.paths("get_dirty_counts").length;
			const event = { repo: "/first", paths: ["file.txt"] };
			const oldRead = busy ? app.host.holdNextReply("get_dirty_counts") : null;
			if (oldRead) {
				await app.host.emitRepoChanged(event);
				app.clock.advanceBy(REPO_CHANGE_DELAY_MS);
				await oldRead.entered;
			}
			app.host.seedResponse("get_dirty_counts", {
				staged: 0,
				unstaged: 1,
				conflicted: 0,
			});

			await app.host.emitRepoChanged({ ...event, command_completed: true });
			oldRead?.release({ staged: 0, unstaged: 0, conflicted: 0 });

			await waitFor(() => expect(app.dirty("first")).toBe(true));
			expect(app.paths("get_dirty_counts")).toHaveLength(
				before + (busy ? 2 : 1),
			);
			expect(app.paths("get_commit_graph")).toEqual(["/active"]);
		},
	);

	it("loads a saved draft on first activation and clears it only after editing", async () => {
		app = new StartupHarness(savedTabs, "active");
		const drafts = {
			"/last": { subject: "saved subject", body: "saved body" },
		};
		app.host.preferences.set("commit_drafts", drafts);
		app.start();
		await screen.findByText("restored history");

		await app.activate("last");
		await screen.findByDisplayValue("saved subject");
		expect(screen.getByDisplayValue("saved body")).toBeInTheDocument();
		expect(
			app.host.requests.filter(
				({ cmd, args }) => cmd === "prefs_set" && args.key === "commit_drafts",
			),
		).toEqual([]);
		await app.clearDraft("saved subject", "saved body");

		expect(app.host.preferences.get("commit_drafts")).toEqual({});
	});
	it("shows saved tabs while opening the saved active repository first", async () => {
		app = new StartupHarness(savedTabs, "active");
		const opening = app.host.holdNextReply("open_repo");

		app.start();
		const request = await opening.entered;
		await app.settle();

		expect(request).toEqual({ path: "/active" });
		expect(
			screen.getAllByRole("tab").map((tab) => tab.textContent?.trim()),
		).toEqual(["first", "active", "last"]);
		expect(screen.getByRole("tab", { name: "active" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(app.paths("get_commit_graph")).toEqual([]);
		opening.release(null);
		await app.settle();
	});

	it("waits for the active graph before preparing inactive repositories serially", async () => {
		app = new StartupHarness(savedTabs, "active");
		const graph = app.host.holdNextReply("get_commit_graph");
		app.start();
		await graph.entered;
		await app.settle();

		app.clock.advanceBy(0);
		expect(app.paths("open_repo")).toEqual(["/active"]);
		graph.release({
			commits: [
				makeCommit({
					oid: "active-history",
					summary: "active history",
					in_head_chain: true,
				}),
			],
			max_columns: 1,
			checked: true,
			revision: 1,
		});
		await screen.findByText("active history");
		await app.settle();
		const first = app.host.holdNextReply("open_repo");
		app.clock.advanceBy(0);
		expect(await first.entered).toEqual({ path: "/first" });
		app.clock.advanceBy(0);
		expect(app.paths("open_repo")).toEqual(["/active", "/first"]);
		first.release(null);
		await app.settle();
		app.clock.advanceBy(0);
		await app.settle();

		expect(app.paths("open_repo")).toEqual(["/active", "/first", "/last"]);
		expect(app.paths("get_commit_graph")).toEqual(["/active"]);
		expect(app.paths("get_status")).toEqual(["/active"]);
	});

	it("mounts an inactive view on selection and retains its selected commit on return", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const activeRow = await app.selectedHistoryRow();

		await app.activate("last");
		await waitFor(() =>
			expect(app.paths("get_commit_graph")).toEqual(["/active", "/last"]),
		);
		await app.activate("active");
		await app.settle();

		expect(activeRow).toBeInTheDocument();
		expect(activeRow).toHaveAttribute("aria-selected", "true");
		expect(app.paths("get_commit_graph")).toEqual(["/active", "/last"]);
	});

	it("prioritizes the latest selection without opening several repositories at once", async () => {
		app = new StartupHarness(savedTabs, "active");
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;

		await app.activate("first");
		await app.activate("last");
		await app.settle();
		expect(app.paths("open_repo")).toEqual(["/active"]);
		opening.release(null);
		await screen.findByText("restored history");
		await app.settle();

		expect(app.paths("open_repo")).toEqual(["/active", "/last"]);
		expect(app.paths("get_commit_graph")).toEqual(["/last"]);
	});

	it("skips a closed pending tab and closes an open that finishes after its tab disappears", async () => {
		app = new StartupHarness(savedTabs, "active");
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;

		await app.close("first");
		await app.close("active");
		await app.settle();
		const closesBeforeCompletion = app.paths("close_repo").length;
		opening.release(null);
		await screen.findByText("restored history");
		await app.settle();
		app.clock.advanceBy(0);
		await app.settle();

		expect(screen.queryByRole("tab", { name: "first" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "active" })).toBeNull();
		expect(app.paths("open_repo")).toEqual(["/active", "/last"]);
		expect(app.paths("get_commit_graph")).toEqual(["/last"]);
		expect(app.paths("close_repo").slice(closesBeforeCompletion)).toEqual([
			"/active",
		]);
	});

	it("says why a recent repository would not open and keeps it in the list", async () => {
		const unplugged = { path: "/Volumes/usb/unplugged", name: "unplugged" };
		app = new StartupHarness([savedTabs[1]], "active");
		app.host.preferences.set("recent_repos", [unplugged]);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent("unplugged");
		await opening.entered;
		opening.reject({
			code: "not_a_git_repo",
			message: "failed to resolve path '/Volumes/usb/unplugged'",
		});
		await app.settle();

		expect(toasts.items).toContainEqual(
			expect.objectContaining({
				message:
					"Could not open unplugged: failed to resolve path '/Volumes/usb/unplugged'",
				kind: "error",
			}),
		);
		expect(app.host.preferences.get("recent_repos")).toEqual([unplugged]);
	});

	it("switches to the tab already showing a repository opened from the welcome screen, without reopening it", async () => {
		app = new StartupHarness([savedTabs[1]], "active");
		app.host.preferences.set("recent_repos", [
			{ path: "/active", name: "active" },
		]);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		const recent = (await screen.findByText("Recent")).parentElement;
		if (!recent) throw new Error("the Recent heading has no list around it");

		await fireEvent.click(await within(recent).findByText("active"));
		await app.settle();

		expect(app.paths("open_repo")).toEqual(["/active"]);
		expect(screen.queryByRole("tab", { name: "New Tab" })).toBeNull();
		expect(screen.getByRole("tab", { name: "active" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("keeps a replacement when the previous repository finishes opening", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.host.preferences.set("recent_repos", [
			{ path: "/replacement", name: "replacement" },
		]);
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;

		await app.pickRecent("replacement");
		await screen.findByText("restored history");
		await app.settle();
		const closesBeforeCompletion = app.paths("close_repo").length;
		opening.release(null);
		await app.settle();

		expect(screen.queryByRole("tab", { name: "active" })).toBeNull();
		expect(screen.getByRole("tab", { name: "replacement" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(app.paths("get_commit_graph")).toEqual(["/replacement"]);
		expect(app.paths("close_repo").slice(closesBeforeCompletion)).toEqual([
			"/active",
		]);
		expect(app.paths("close_repo")).not.toContain("/replacement");
	});

	it("mounts a prepared tab when selected without opening it again", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await app.prepareNextRepository();

		await app.activate("first");
		await waitFor(() =>
			expect(app.paths("get_commit_graph")).toEqual(["/active", "/first"]),
		);

		expect(app.paths("open_repo")).toEqual(["/active", "/first"]);
		await waitFor(() =>
			expect(screen.getAllByText("restored history")).toHaveLength(2),
		);
	});

	it("continues background preparation when review replaces a pending graph", async () => {
		app = new StartupHarness(savedTabs, "active");
		const graph = app.host.holdNextReply("get_commit_graph");
		app.start();
		await graph.entered;

		await app.enterReview();
		await app.settle();
		await app.prepareNextRepository();
		await app.prepareNextRepository();
		const opened = app.paths("open_repo");
		graph.release({ commits: [], max_columns: 0, revision: 1, checked: true });
		await app.settle();

		expect(opened).toEqual(["/active", "/first", "/last"]);
	});

	it("opens the selected tab while a background dirty scan is still pending", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const counts = app.host.holdNextReply("get_dirty_counts");
		await app.prepareNextRepository();
		await counts.entered;

		await app.activate("last");
		await app.settle();
		const opened = app.paths("open_repo");
		counts.release({ staged: 0, unstaged: 0, conflicted: 0 });
		await app.settle();

		expect(opened).toEqual(["/active", "/first", "/last"]);
	});

	it("ignores a background dirty scan that finishes after its view mounts", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const counts = app.host.holdNextReply("get_dirty_counts");
		await app.prepareNextRepository();
		await counts.entered;

		await app.activate("first");
		await waitFor(() =>
			expect(app.paths("get_commit_graph")).toContain("/first"),
		);
		await app.settle();
		counts.release({ staged: 0, unstaged: 1, conflicted: 0 });
		await app.settle();

		expect(app.dirty("first")).toBe(false);
	});

	it("removes a missing inactive repository without changing the active tab", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const missing = app.host.holdNextReply("open_repo");
		await app.prepareNextRepository();
		await missing.entered;

		missing.reject({ code: "not_found", message: "missing repository" });
		await app.settle();

		expect(screen.queryByRole("tab", { name: "first" })).toBeNull();
		expect(screen.getByRole("tab", { name: "active" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("says why it closed the tab of a repository that will not open", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const missing = app.host.holdNextReply("open_repo");
		await app.prepareNextRepository();
		await missing.entered;

		missing.reject({
			code: "not_a_git_repo",
			message: "could not find repository at '/first'",
		});
		await app.settle();

		expect(toasts.items).toContainEqual(
			expect.objectContaining({
				message:
					"Closed the tab for first because it could not be opened: could not find repository at '/first'",
				kind: "error",
			}),
		);
	});

	it("selects the adjacent tab when a newly selected repository is missing", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const missing = app.host.holdNextReply("open_repo");

		await app.activate("last");
		await missing.entered;
		missing.reject({ code: "not_found", message: "missing repository" });
		await app.settle();

		expect(screen.queryByRole("tab", { name: "last" })).toBeNull();
		expect(screen.getByRole("tab", { name: "active" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("falls back when the saved active repository is missing", async () => {
		app = new StartupHarness(savedTabs, "active");
		const missing = app.host.holdNextReply("open_repo");
		app.start();
		await missing.entered;

		missing.reject({ code: "not_found", message: "missing repository" });
		await screen.findByText("restored history");
		await app.settle();

		expect(screen.queryByRole("tab", { name: "active" })).toBeNull();
		expect(screen.getByRole("tab", { name: "first" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(app.paths("get_commit_graph")).toEqual(["/first"]);
	});

	it("restores the legacy repository and clears its old preference", async () => {
		app = new StartupHarness([], "missing");
		app.host.preferences.set("open_repo", { path: "/legacy", name: "legacy" });

		app.start();
		await screen.findByText("restored history");

		expect(app.paths("open_repo")).toEqual(["/legacy"]);
		expect(app.host.preferences.get("open_repo")).toBeNull();
		expect(screen.getByRole("tab", { name: "legacy" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("returns to the welcome screen when the only repository is missing", async () => {
		app = new StartupHarness([savedTabs[1]], "active");
		const missing = app.host.holdNextReply("open_repo");
		app.start();
		await missing.entered;

		missing.reject({ code: "not_found", message: "missing repository" });
		await screen.findByRole("tab", { name: "New Tab" });

		expect(app.paths("get_commit_graph")).toEqual([]);
		expect(
			screen.getByRole("button", { name: "Open Repository" }),
		).toBeInTheDocument();
	});

	it("fetches prepared inactive repositories without mounting their views", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.host.preferences.set("fetch_interval_ms", 60_000);
		app.host.seedResponse("git_fetch_background", {
			outcome: "unchanged",
			remotes: [],
			graph_error: null,
			graph_rebuilds: 0,
		});
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;
		await app.settle();

		app.clock.advanceBy(120_000);
		expect(app.paths("git_fetch_background")).toEqual([]);
		opening.release(null);
		await screen.findByText("restored history");
		await app.settle();
		app.clock.advanceBy(0);
		await app.settle();
		app.clock.advanceBy(0);
		await app.settle();
		await app.advanceFetches(3);

		expect(new Set(app.paths("git_fetch_background"))).toEqual(
			new Set(["/active", "/first", "/last"]),
		);
		expect(app.paths("get_commit_graph")).toEqual(["/active"]);
	});
});
