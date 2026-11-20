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
import { makeCommit, makeRef } from "../__tests__/helpers/factories.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { noReviewCounts } from "../__tests__/helpers/review-props.js";
import { ROW_HEIGHT } from "../lib/chrome-heights.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type { GraphResponse } from "../lib/types.js";
import CommitGraph from "./CommitGraph.svelte";

let host: RepositoryReadHost;
let clock: FakeScheduler;

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
});

function graph(revision: number): GraphResponse {
	return {
		commits: [
			makeCommit({
				oid: "head",
				summary: `revision ${revision}`,
				in_head_chain: true,
			}),
		],
		max_columns: 1,
		checked: true,
		revision,
	};
}

function mountGraph(
	cachedGraphRevision: number,
	gates: { visibilityResolved?: boolean; repoListenerSettled?: boolean } = {},
) {
	return render(CommitGraph, {
		props: {
			...noReviewCounts(),
			repoPath: "/repo",
			remoteState: createRemoteState(),
			tabActive: true,
			refreshSignal: 0,
			cachedGraphRevision,
			...gates,
		},
		context: new Map([[SCHEDULER, clock]]),
	});
}

/** A graph the watcher reported a change against since it was published. */
function unchecked(revision: number): GraphResponse {
	return { ...graph(revision), checked: false };
}

function graphViewport(container: HTMLElement): HTMLElement {
	const viewport = container.querySelector<HTMLElement>(
		".virtual-list-viewport",
	);
	if (!viewport) throw new Error("missing graph viewport");
	return viewport;
}

describe("CommitGraph before its first page", () => {
	it("shows no uncommitted changes row alone while the stored ref visibility is read", async () => {
		host.seedGraph(graph(5));
		const view = render(CommitGraph, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				remoteState: createRemoteState(),
				tabActive: true,
				refreshSignal: 0,
				cachedGraphRevision: 5,
				wipCount: 2,
				visibilityResolved: false,
			},
			context: new Map([[SCHEDULER, clock]]),
		});
		await tick();
		const rowsBeforeThePage = screen.queryAllByTestId("commit-row-summary");

		await view.rerender({ visibilityResolved: true });

		expect(rowsBeforeThePage).toEqual([]);
		await screen.findByText("revision 5");
		expect(screen.getAllByTestId("commit-row-summary")).toHaveLength(2);
	});
});

describe("CommitGraph automatic ref updates", () => {
	// TRUNK-494: the view's first graph can predate a change whose event no listener heard.
	it("refreshes a first page that predates a reported change", async () => {
		host.seedGraph(unchecked(5));
		host.seedResponse("refresh_commit_graph", graph(6));
		mountGraph(5);

		await screen.findByText("revision 6");

		expect(host.count("refresh_commit_graph")).toBe(1);
	});

	// The listener hears every change after the first graph, so it brings its own refresh.
	it("shows a later unchecked graph as it stands", async () => {
		host.seedGraph(graph(5));
		host.seedResponse("refresh_commit_graph", graph(7));
		const view = mountGraph(5);
		await screen.findByText("revision 5");

		view.component.showGraph(unchecked(6));
		await tick();

		expect(screen.getByText("revision 6")).toBeInTheDocument();
		expect(host.count("refresh_commit_graph")).toBe(0);
	});

	it("refreshes a first graph shown by a visibility push that predates a reported change", async () => {
		host.seedResponse("refresh_commit_graph", graph(6));
		const view = mountGraph(5, { visibilityResolved: false });

		view.component.showGraph(unchecked(5));

		await screen.findByText("revision 6");
		expect(host.count("refresh_commit_graph")).toBe(1);
	});

	it("reads no page until the view's repo-changed listener is registered", async () => {
		host.seedGraph(graph(5));
		const view = mountGraph(5, { repoListenerSettled: false });
		await tick();
		const pagesBeforeRegistration = host.count("get_commit_graph");

		await view.rerender({ repoListenerSettled: true });

		expect(pagesBeforeRegistration).toBe(0);
		await screen.findByText("revision 5");
	});

	it("uses the pending initial page when its revision already matches the publication", async () => {
		const first = host.holdNextReply("get_commit_graph");
		host.seedGraph(graph(5));
		mountGraph(5);
		await first.entered;
		await tick();

		expect(host.count("get_commit_graph")).toBe(1);
		first.release(graph(5));
		await screen.findByText("revision 5");
		await tick();

		expect(host.count("get_commit_graph")).toBe(1);
	});

	it("catches a newer publication arriving before the initial page resolves", async () => {
		const first = host.holdNextReply("get_commit_graph");
		const newer = host.holdNextReply("get_commit_graph");
		const view = mountGraph(1);
		await first.entered;

		await view.rerender({ cachedGraphRevision: 6 });
		expect(host.count("get_commit_graph")).toBe(1);
		first.release(graph(5));
		await newer.entered;
		newer.release(graph(6));
		await screen.findByText("revision 6");

		expect(host.count("get_commit_graph")).toBe(2);
		expect(host.count("refresh_commit_graph")).toBe(0);
	});

	it("ignores equal and older publications after a graph has loaded", async () => {
		host.seedGraph(graph(5));
		const view = mountGraph(5);
		await screen.findByText("revision 5");
		const before = host.count("get_commit_graph");

		await view.rerender({ cachedGraphRevision: 5 });
		await view.rerender({ cachedGraphRevision: 4 });
		clock.advanceBy(200);
		await tick();

		expect(host.count("get_commit_graph")).toBe(before);
	});

	it("preserves a loaded second page, its selected row and immutable stats across a refs publication", async () => {
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		const commits = Array.from({ length: 400 }, (_, index) =>
			makeCommit({
				oid: `oid-${index}`,
				summary: `commit ${index}`,
				in_head_chain: true,
			}),
		);
		const stats = (start: number, end: number) =>
			Object.fromEntries(
				commits
					.slice(start, end)
					.map(({ oid }) => [
						oid,
						{ files_changed: 1, insertions: 11, deletions: 0 },
					]),
			);
		host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
		host.seedResponse("get_commit_stats", stats(0, 200));
		const view = mountGraph(1);
		await screen.findByText("commit 0");
		await waitFor(() =>
			expect(screen.getAllByTestId("diff-stat-bar").length).toBeGreaterThan(0),
		);
		const secondStats = host.holdNextReply("get_commit_stats");
		await view.rerender({ selectedCommitOid: "oid-250" });
		await view.component.scrollToOid("oid-250");
		vi.advanceTimersToNextFrame();
		await tick();
		await fireEvent.scroll(graphViewport(view.container), {
			target: { scrollTop: 250 * ROW_HEIGHT },
		});
		vi.advanceTimersToNextFrame();
		await tick();
		const requestedStats = await secondStats.entered;
		expect(requestedStats.path).toBe("/repo");
		expect(requestedStats.revision).toBe(1);
		expect(Number(requestedStats.count)).toBeLessThanOrEqual(32);
		expect(Number(requestedStats.offset)).toBeGreaterThanOrEqual(200);
		host.seedResponse("get_commit_stats", stats(200, 400));
		secondStats.release(
			stats(
				Number(requestedStats.offset),
				Number(requestedStats.offset) + Number(requestedStats.count),
			),
		);
		await screen.findByText("commit 250");
		await waitFor(() =>
			expect(
				screen
					.getByText("commit 250")
					.closest('[data-testid="commit-row"]')
					?.querySelector('[data-diff-seg="add"]'),
			).toBeTruthy(),
		);
		const reads = host.count("get_commit_stats");
		host.seedResponse("get_commit_stats", {});
		const fetched = commits.map((commit) =>
			commit.oid === "oid-250"
				? {
						...commit,
						refs: [
							makeRef({
								short_name: "origin/fetched",
								ref_type: "RemoteBranch",
							}),
						],
					}
				: commit,
		);
		host.seedGraph({
			commits: fetched,
			max_columns: 1,
			revision: 2,
			checked: true,
		});
		await view.rerender({ cachedGraphRevision: 2 });
		await screen.findByText("origin/fetched");
		const selected = screen
			.getByText("commit 250")
			.closest('[data-testid="commit-row"]');

		expect(view.component.loadedRows()).toBe(400);
		expect(
			host.requests
				.filter(
					({ cmd, args }) =>
						cmd === "get_commit_graph" && args.loaded !== undefined,
				)
				.map(({ args }) => args),
		).toEqual([{ path: "/repo", offset: 0, loaded: 400 }]);
		expect(selected).toHaveAttribute("aria-selected", "true");
		expect(selected?.querySelector('[data-diff-seg="add"]')).toBeTruthy();
		expect(host.count("get_commit_stats")).toBe(reads);
		expect(host.count("refresh_commit_graph")).toBe(0);
	});

	it("recovers a backend graph_changed stats rejection through the cached graph", async () => {
		const oldStats = host.holdNextReply("get_commit_stats");
		host.seedGraph(graph(1));
		mountGraph(1);
		await oldStats.entered;
		host.seedGraph(graph(2));
		host.seedResponse("get_commit_stats", {
			head: { files_changed: 1, insertions: 0, deletions: 22 },
		});

		oldStats.reject({ code: "graph_changed", message: "Graph changed" });
		await screen.findByText("revision 2");
		await waitFor(() =>
			expect(
				screen
					.getByTestId("diff-stat")
					.querySelector('[data-diff-seg="delete"]'),
			).toBeTruthy(),
		);

		expect(host.count("get_commit_graph")).toBe(2);
		expect(host.count("refresh_commit_graph")).toBe(0);
		expect(
			host.requests
				.filter(({ cmd }) => cmd === "get_commit_stats")
				.map(({ args }) => args.revision),
		).toEqual([1, 2]);
	});

	it("drops a stats reply from the old revision while the replacement stats are pending", async () => {
		const oldStats = host.holdNextReply("get_commit_stats");
		const newStats = host.holdNextReply("get_commit_stats");
		host.seedGraph(graph(1));
		const view = mountGraph(1);
		await oldStats.entered;
		host.seedGraph(graph(2));

		await view.rerender({ cachedGraphRevision: 2 });
		await screen.findByText("revision 2");
		oldStats.release({
			head: { files_changed: 1, insertions: 11, deletions: 0 },
		});
		await waitFor(() => expect(clock.pending).toBeGreaterThan(0));
		clock.flush();
		await newStats.entered;
		await tick();

		expect(
			screen.getByTestId("diff-stat").querySelector('[data-diff-seg="add"]'),
		).toBeNull();
		newStats.release({
			head: { files_changed: 1, insertions: 0, deletions: 22 },
		});
		await waitFor(() =>
			expect(
				screen
					.getByTestId("diff-stat")
					.querySelector('[data-diff-seg="delete"]'),
			).toBeTruthy(),
		);
	});

	it("recovers a rejected page while retaining stats for commits still in the replacement", async () => {
		const commits = Array.from({ length: 200 }, (_, index) =>
			makeCommit({
				oid: `oid-${index}`,
				summary: `commit ${index}`,
				in_head_chain: true,
			}),
		);
		host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
		host.seedResponse(
			"get_commit_stats",
			Object.fromEntries(
				commits.map(({ oid }) => [
					oid,
					{ files_changed: 1, insertions: 11, deletions: 0 },
				]),
			),
		);
		const view = mountGraph(1);
		await screen.findByText("commit 0");
		await waitFor(() =>
			expect(screen.getAllByTestId("diff-stat-bar").length).toBeGreaterThan(0),
		);
		const page = host.holdNextReply("get_commit_graph");
		const replacement = {
			...graph(2),
			commits: [
				commits[0],
				makeCommit({
					oid: "target-oid",
					summary: "new target commit",
					in_head_chain: true,
				}),
			],
		};
		host.seedGraph(replacement);
		host.seedResponse("get_commit_stats", {
			"target-oid": { files_changed: 1, insertions: 0, deletions: 22 },
		});
		const before = host.count("get_commit_stats");

		const reached = view.component.scrollToOid("target-oid");
		expect(await page.entered).toEqual({
			path: "/repo",
			offset: 200,
			revision: 1,
			through: "target-oid",
		});
		page.reject({ code: "graph_changed", message: "Graph changed" });
		await reached;
		await screen.findByText("new target commit");
		await waitFor(() =>
			expect(host.count("get_commit_stats")).toBe(before + 1),
		);

		expect(
			screen
				.getByText("commit 0")
				.closest('[data-testid="commit-row"]')
				?.querySelector('[data-diff-seg="add"]'),
		).toBeTruthy();
		expect(host.count("refresh_commit_graph")).toBe(0);
	});
});
