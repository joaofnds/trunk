import { screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import { REPO_CHANGE_DELAY_MS } from "./lib/coalesced-task.js";

const savedTabs = [
	{ id: "first", repoPath: "/first", repoName: "first" },
	{ id: "active", repoPath: "/active", repoName: "active" },
	{ id: "last", repoPath: "/last", repoName: "last" },
];
let app: StartupHarness;
afterEach(() => app?.teardown());

describe("App startup", () => {
	it("reads initial refs and dirty counts once for the visible repository", async () => {
		app = new StartupHarness(savedTabs, "active");

		app.start();
		await screen.findByText("restored history");
		await app.settle();

		expect(app.paths("list_refs")).toEqual(["/active"]);
		expect(app.paths("get_dirty_counts")).toEqual(["/active"]);
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

	it("keeps a replacement when the previous repository finishes opening", async () => {
		app = new StartupHarness(savedTabs, "active");
		app.host.preferences.set("recent_repos", [
			{ path: "/replacement", name: "replacement" },
		]);
		app.host.seedResponse("validate_recent_path", true);
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
		graph.release({ commits: [], max_columns: 0, revision: 1 });
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
