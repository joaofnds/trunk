import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { makeCommit } from "../__tests__/helpers/factories.js";
import GraphRefreshHarness from "../__tests__/helpers/graph-refresh-harness.svelte";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { noReviewCounts } from "../__tests__/helpers/review-props.js";
import { ROW_HEIGHT } from "../lib/chrome-heights.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { createUndoRedoState } from "../lib/undo-redo.svelte.js";
import CommitGraph from "./CommitGraph.svelte";
import RepoView from "./RepoView.svelte";

let host: RepositoryReadHost;
let clock: FakeScheduler;
const originalConsoleError = console.error;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills({ viewportHeight: 200 });
});

afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	vi.useRealTimers();
	console.error = originalConsoleError;
});

describe("CommitGraph", () => {
	describe("visible graph statistics", () => {
		it("defers stats for a hidden Diff column and loads them when shown", async () => {
			host.preferences.set("column_visibility", { diff: false });
			host.seedGraph(graph(1));
			host.seedResponse("get_commit_stats", {
				head: { files_changed: 1, insertions: 7, deletions: 0 },
			});
			const view = render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("revision 1");
			await tick();

			expect(view.container.querySelector('[data-column="diff"]')).toBeNull();
			expect(host.count("get_commit_stats")).toBe(0);
			expect(host.count("get_wip_diff_stats")).toBe(0);
			await fireEvent.contextMenu(screen.getByTestId("column-header"));
			await waitFor(() =>
				expect(
					host.contextMenu.items().some(({ label }) => label === "Diff"),
				).toBe(true),
			);
			host.contextMenu.choose("Diff");
			await screen.findByTestId("diff-stat-bar");
			expect(host.count("get_commit_stats")).toBe(1);
		});

		it("does no stats work for an inactive tab", async () => {
			host.seedGraph(graph(1));
			render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: false },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("revision 1");
			await tick();

			expect(host.count("get_commit_stats")).toBe(0);
			expect(host.count("get_wip_diff_stats")).toBe(0);
		});

		it("fills healthy rendered rows after an entirely unavailable leading batch", async () => {
			restoreDomPolyfills();
			installDomPolyfills({ viewportHeight: 1400 });
			const commits = history(150);
			host.seedGraph({ commits, max_columns: 1, revision: 1 });
			host.seedResponse("get_commit_stats", stats(commits.slice(32)));
			const view = render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			await waitFor(() =>
				expect(
					screen
						.getByText("commit 64")
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);
			const rows = [
				...view.container.querySelectorAll<HTMLElement>(
					"[data-original-index]",
				),
			];
			const end =
				Math.max(...rows.map((row) => Number(row.dataset.originalIndex))) + 1;
			await waitFor(() =>
				expect(
					host.requests.filter(({ cmd }) => cmd === "get_commit_stats").length,
				).toBe(Math.ceil(end / 32)),
			);
			clock.advanceBy(200);
			await tick();

			for (const { args } of host.requests.filter(
				({ cmd }) => cmd === "get_commit_stats",
			)) {
				expect(Number(args.count)).toBeLessThanOrEqual(32);
				expect(Number(args.offset) + Number(args.count)).toBeLessThanOrEqual(
					end,
				);
			}
			expect(host.count("get_commit_stats")).toBe(Math.ceil(end / 32));
			expect(
				screen
					.getByText("commit 0")
					.closest('[data-testid="commit-row"]')
					?.querySelector('[data-diff-seg="add"]'),
			).toBeNull();
		});

		it("follows a scroll that arrives while a stats request is in flight", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const commits = history(150);
			host.seedGraph({ commits, max_columns: 1, revision: 1 });
			host.seedResponse("get_commit_stats", stats(commits));
			const first = host.holdNextReply("get_commit_stats");
			const view = render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			const firstArgs = await first.entered;
			await screen.findByText("commit 0");
			vi.advanceTimersToNextFrame();
			await tick();
			const viewport = graphViewport(view.container);
			await fireEvent.scroll(viewport, {
				target: { scrollTop: 70 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await tick();
			expect(host.count("get_commit_stats")).toBe(1);
			first.release(stats(commits.slice(0, Number(firstArgs.count))));
			await waitFor(() =>
				expect(
					screen
						.getByText("commit 70")
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);

			const next = host.requests.filter(
				({ cmd }) => cmd === "get_commit_stats",
			)[1];
			expect(Number(next.args.offset)).toBeGreaterThan(32);
			expect(Number(next.args.count)).toBeLessThanOrEqual(32);
		});

		it("resumes stats when an inactive tab becomes active", async () => {
			host.seedGraph(graph(1));
			host.seedResponse("get_commit_stats", {
				head: { files_changed: 1, insertions: 7, deletions: 0 },
			});
			const view = render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: false },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("revision 1");
			expect(host.count("get_commit_stats")).toBe(0);
			await view.rerender({ tabActive: true });
			await screen.findByTestId("diff-stat-bar");

			expect(host.count("get_commit_stats")).toBe(1);
		});

		it("reports a stats failure once without retrying it automatically", async () => {
			host.seedGraph(graph(1));
			const failure = host.holdNextReply("get_commit_stats");
			const errors: unknown[][] = [];
			console.error = (...args) => errors.push(args);
			render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			await failure.entered;
			failure.reject({ code: "io_error", message: "stats unavailable" });
			await waitFor(() =>
				expect(errors).toEqual([
					[
						"Coalesced task failed",
						{ code: "io_error", message: "stats unavailable" },
					],
				]),
			);
			clock.flush();
			await tick();

			expect(host.count("get_commit_stats")).toBe(1);
			expect(errors).toHaveLength(1);
		});

		it("attempts each row once across overlapping scroll windows", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const commits = history(150);
			host.seedGraph({ commits, max_columns: 1, revision: 1 });
			host.seedResponse(
				"get_commit_stats",
				stats(commits.filter((_, i) => i !== 55)),
			);
			const view = render(CommitGraph, {
				props: { ...noReviewCounts(), repoPath: "/repo", tabActive: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findAllByTestId("diff-stat-bar");
			vi.advanceTimersToNextFrame();
			await tick();
			const viewport = graphViewport(view.container);
			await fireEvent.scroll(viewport, {
				target: { scrollTop: 70 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await waitFor(() =>
				expect(
					screen
						.getByText("commit 90")
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);
			await fireEvent.scroll(viewport, {
				target: { scrollTop: 50 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await waitFor(() =>
				expect(
					screen
						.getByText("commit 30")
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);

			const requested = host.requests
				.filter(({ cmd }) => cmd === "get_commit_stats")
				.flatMap(({ args }) =>
					Array.from(
						{ length: Number(args.count) },
						(_, i) => Number(args.offset) + i,
					),
				);
			expect(requested.filter((index) => index === 55)).toHaveLength(1);
			expect(new Set(requested).size).toBe(requested.length);
		});

		it("fills the newly rendered tail when the WIP row disappears", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const commits = history(150);
			host.seedGraph({ commits, max_columns: 1, revision: 1 });
			host.seedResponse("get_commit_stats", stats(commits));
			const view = render(GraphRefreshHarness, {
				props: { withWip: true },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("commit 0");
			vi.advanceTimersToNextFrame();
			await tick();
			await fireEvent.scroll(graphViewport(view.container), {
				target: { scrollTop: 70 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await waitFor(() =>
				expect(
					screen
						.getByText("commit 90")
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);
			const end = Math.max(
				...[
					...view.container.querySelectorAll<HTMLElement>(
						"[data-original-index]",
					),
				].map((row) => Number(row.dataset.originalIndex)),
			);
			await waitFor(() =>
				expect(
					screen
						.getByText(`commit ${end - 1}`)
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);
			await tick();
			clock.flush();
			await tick();

			await fireEvent.click(screen.getByRole("button", { name: "Clear WIP" }));
			expect(
				Math.max(
					...[
						...view.container.querySelectorAll<HTMLElement>(
							"[data-original-index]",
						),
					].map((row) => Number(row.dataset.originalIndex)),
				),
			).toBe(end);

			await waitFor(() =>
				expect(
					screen
						.getByText(`commit ${end}`)
						.closest('[data-testid="commit-row"]')
						?.querySelector('[data-diff-seg="add"]'),
				).toBeTruthy(),
			);
		});
	});

	function graph(revision: number) {
		return {
			commits: [
				makeCommit({
					oid: "head",
					summary: `revision ${revision}`,
					in_head_chain: true,
				}),
			],
			max_columns: 1,
			revision,
		};
	}

	function graphViewport(container: HTMLElement): HTMLElement {
		const viewport = container.querySelector<HTMLElement>(
			".virtual-list-viewport",
		);
		if (!viewport) throw new Error("missing graph viewport");

		return viewport;
	}

	function mountRefresh(props = {}) {
		return render(GraphRefreshHarness, {
			props,
			context: new Map([[SCHEDULER, clock]]),
		});
	}

	function history(count: number) {
		return Array.from({ length: count }, (_, index) =>
			makeCommit({
				oid: `oid-${index}`,
				summary: `commit ${index}`,
				in_head_chain: index === 0,
			}),
		);
	}

	function stats(commits: ReturnType<typeof history>) {
		return Object.fromEntries(
			commits.map(({ oid }) => [
				oid,
				{ files_changed: 1, insertions: 11, deletions: 0 },
			]),
		);
	}

	describe("graph refresh consumption", () => {
		it("does not replay a consumed notification when the graph remounts", async () => {
			host.seedGraph(graph(1));
			host.seedResponse("refresh_commit_graph", graph(2));
			const view = mountRefresh();
			await screen.findByText("revision 1");
			await view.rerender({ refreshSignal: 1 });
			await screen.findByText("revision 2");
			host.seedGraph(graph(2));
			await view.rerender({ visible: false });
			await view.rerender({ visible: true });
			await screen.findByText("revision 2");
			await tick();

			expect(host.count("refresh_commit_graph")).toBe(1);
		});

		it("captures a notification received while the graph is absent", async () => {
			host.seedGraph(graph(1));
			host.seedResponse("refresh_commit_graph", graph(2));
			const view = mountRefresh({ visible: false });
			await view.rerender({ refreshSignal: 1 });
			expect(host.count("refresh_commit_graph")).toBe(0);
			await view.rerender({ visible: true });
			await screen.findByText("revision 2");

			expect(host.count("refresh_commit_graph")).toBe(1);
		});

		it("acknowledges a completed capture after its graph pane unmounts", async () => {
			host.seedGraph(graph(1));
			const capture = host.holdNextReply("refresh_commit_graph");
			const consumed: number[] = [];
			const view = mountRefresh({
				onconsumed: (generation: number) => consumed.push(generation),
			});
			await screen.findByText("revision 1");
			await view.rerender({ refreshSignal: 1 });
			await capture.entered;
			await view.rerender({ visible: false });
			host.seedGraph(graph(2));
			capture.release(graph(2));
			await waitFor(() => expect(consumed).toEqual([1]));
			await view.rerender({ visible: true });
			await screen.findByText("revision 2");

			expect(host.count("refresh_commit_graph")).toBe(1);
		});

		it("keeps a newer notification outstanding when an earlier capture completes", async () => {
			host.seedGraph(graph(1));
			const first = host.holdNextReply("refresh_commit_graph");
			const second = host.holdNextReply("refresh_commit_graph");
			const view = mountRefresh();
			await screen.findByText("revision 1");
			await view.rerender({ refreshSignal: 1 });
			await first.entered;
			await view.rerender({ refreshSignal: 2 });
			first.release(graph(2));
			await screen.findByText("revision 2");
			await view.rerender({ visible: false });
			await view.rerender({ visible: true });
			await second.entered;
			second.release(graph(3));
			await screen.findByText("revision 3");

			expect(host.count("refresh_commit_graph")).toBe(2);
		});

		it("retries a retained capture on remount", async () => {
			host.seedGraph(graph(1));
			const failed = host.holdNextReply("refresh_commit_graph");
			const view = mountRefresh();
			await screen.findByText("revision 1");
			await view.rerender({ refreshSignal: 1 });
			await failed.entered;
			failed.reject({ code: "graph_changed", message: "unstable capture" });
			await screen.findByText("unstable capture");
			host.seedResponse("refresh_commit_graph", graph(2));
			await view.rerender({ visible: false });
			await view.rerender({ visible: true });
			await screen.findByText("revision 2");

			expect(host.count("refresh_commit_graph")).toBe(2);
		});

		it("waits for stored ref visibility before consuming a notification", async () => {
			host.seedGraph(graph(1));
			host.seedResponse("refresh_commit_graph", graph(2));
			const view = mountRefresh({
				refreshSignal: 1,
				visibilityResolved: false,
			});
			await tick();
			expect(host.count("refresh_commit_graph")).toBe(0);
			await view.rerender({ visibilityResolved: true });
			await screen.findByText("revision 2");

			expect(host.count("refresh_commit_graph")).toBe(1);
		});
	});
});

describe("RepoView", () => {
	it("keeps a consumed notification consumed after opening and closing a diff", async () => {
		const commit = makeCommit({
			oid: "head",
			summary: "updated history",
			in_head_chain: true,
		});
		const graph = { commits: [commit], max_columns: 1, revision: 2 };
		host.seedGraph({ ...graph, revision: 1 });
		host.seedResponse("refresh_commit_graph", graph);
		host.seedResponse("get_commit_detail", {
			...commit,
			committer_name: "Test",
			committer_email: "test@example.invalid",
			committer_timestamp: 0,
		});
		host.seedResponse("list_commit_files", [
			{
				path: "tracked.txt",
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			},
		]);
		host.seedResponse("diff_commit_file", [
			{
				path: "tracked.txt",
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			},
		]);
		render(RepoView, {
			props: {
				repoPath: "/repo",
				repoName: "repo",
				remoteState: createRemoteState(),
				undoRedo: createUndoRedoState(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				contentMode: "hunk",
				oncontentmodechange: () => {},
				onreviewpanelshowingchange: () => {},
				onleftpanecollapsedchange: () => {},
				onrightpanecollapsedchange: () => {},
				onleftpanewidthchange: () => {},
				onrightpanewidthchange: () => {},
				onleavereview: () => {},
			},
			context: new Map([[SCHEDULER, clock]]),
		});
		await screen.findByText("updated history");
		await host.emitRepoChanged({ repo: "/repo", paths: ["tracked.txt"] });
		clock.flush();
		await waitFor(() => expect(host.count("refresh_commit_graph")).toBe(1));
		await tick();
		host.seedGraph(graph);
		await fireEvent.click(screen.getByTestId("commit-row"));
		await fireEvent.click(await screen.findByText("tracked.txt"));
		await fireEvent.click(
			await screen.findByRole("button", { name: "Close diff" }),
		);
		await screen.findByTestId("commit-row");
		await tick();

		expect(host.count("refresh_commit_graph")).toBe(1);
	});
});
