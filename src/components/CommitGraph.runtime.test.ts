import { setImmediate } from "node:timers/promises";
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
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import CommitGraph from "./CommitGraph.svelte";
import RepoView from "./RepoView.svelte";

let host: RepositoryReadHost;
let clock: FakeScheduler;
const originalConsoleError = console.error;

beforeEach(() => {
	_resetToasts();
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills({ viewportHeight: 200 });
});

afterEach(() => {
	_resetToasts();
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	vi.useRealTimers();
	console.error = originalConsoleError;
});

describe("CommitGraph", () => {
	describe("graph paging", () => {
		it("keeps a deep jump in view when a shallower refresh lands afterward", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const publishedDepths: number[] = [];
			const { view, snapshot } = await openPagedGraph((rows) =>
				publishedDepths.push(rows.length),
			);
			const viewport = graphViewport(view.container);
			followViewportScroll(viewport);
			const refresh = host.holdNextReply("refresh_commit_graph");
			await view.rerender({ refreshSignal: 1 });
			expect(await refresh.entered).toEqual({ path: "/repo", loaded: 200 });
			const updated = {
				...snapshot,
				revision: 2,
				commits: snapshot.commits.map((commit) => ({
					...commit,
					summary: `updated ${commit.summary}`,
				})),
			};

			await view.component.scrollToOid("oid-700");
			vi.advanceTimersToNextFrame();
			await tick();
			expect(screen.getByText("commit 700")).toBeInTheDocument();
			const readingTop = viewport.scrollTop;
			publishedDepths.length = 0;
			host.seedGraph(updated);
			refresh.release({ ...updated, commits: updated.commits.slice(0, 200) });
			await setImmediate();

			expect(publishedDepths).toEqual([snapshot.commits.length]);
			expect(screen.queryByText("updated commit 700")).toBeInTheDocument();
			expect(viewport.scrollTop).toBe(readingTop);
		});

		it("publishes the newest graph when a visibility reply overlaps a cached read", async () => {
			const { view, snapshot } = await openPagedGraph();
			const cached = host.holdNextReply("get_commit_graph");
			await view.rerender({ cachedGraphRevision: 3 });
			await cached.entered;
			const visibility = {
				...snapshot,
				revision: 2,
				commits: [makeCommit({ oid: "visible", summary: "visibility tip" })],
			};
			view.component.showGraph(visibility);
			cached.release({
				...snapshot,
				revision: 3,
				commits: [makeCommit({ oid: "newest", summary: "newest tip" })],
			});
			await setImmediate();
			expect(screen.getByText("newest tip")).toBeInTheDocument();

			view.component.showGraph(visibility);
			await tick();
			expect(screen.getByText("newest tip")).toBeInTheDocument();
			expect(screen.queryByText("visibility tip")).toBeNull();
		});

		it("finishes loading the visible revision while another refresh is pending", async () => {
			const { view, snapshot } = await openPagedGraph();
			await view.component.scrollToOid("oid-700");
			const visible = {
				...snapshot,
				revision: 2,
				commits: snapshot.commits.slice(1),
			};
			const prefix = host.holdNextReply("get_commit_graph");
			view.component.showGraph({
				...visible,
				commits: visible.commits.slice(0, 200),
			});
			await prefix.entered;
			const refresh = host.holdNextReply("refresh_commit_graph");
			await view.rerender({ refreshSignal: 1 });
			await refresh.entered;

			prefix.release(visible);
			await setImmediate();
			const loaded = view.component.loadedRows();
			refresh.release(visible);
			await setImmediate();

			expect(loaded).toBe(visible.commits.length);
		});

		it("preserves a later scroll while a cached replacement catches up", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const { view, snapshot } = await openPagedGraph();
			const viewport = graphViewport(view.container);
			followViewportScroll(viewport);
			const cached = host.holdNextReply("get_commit_graph");
			await view.rerender({ cachedGraphRevision: 2 });
			expect(await cached.entered).toMatchObject({ offset: 0, loaded: 200 });
			await view.component.scrollToOid("oid-700");
			const replacement = {
				...snapshot,
				revision: 2,
				commits: [
					makeCommit({ oid: "new-tip", in_head_chain: true }),
					...snapshot.commits,
				],
			};
			const depth = host.holdNextReply("get_commit_graph");
			cached.release({
				...replacement,
				commits: replacement.commits.slice(0, 200),
			});
			expect(await depth.entered).toMatchObject({ offset: 0, loaded: 840 });

			const readingTop = 550 * ROW_HEIGHT + 3;
			viewport.scrollTo({ top: readingTop });
			vi.advanceTimersToNextFrame();
			await tick();
			host.seedGraph(replacement);
			depth.release({
				...replacement,
				commits: replacement.commits.slice(0, 840),
			});
			await setImmediate();
			vi.advanceTimersToNextFrame();
			await tick();

			expect(screen.getByText("commit 550")).toBeInTheDocument();
			expect(viewport.scrollTop).toBe(readingTop + ROW_HEIGHT);
		});

		it("keeps a deep reading position when visibility replaces the graph", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const { view, snapshot } = await openPagedGraph();
			const viewport = graphViewport(view.container);
			followViewportScroll(viewport);
			const visibilityDepth = view.component.loadedRows();
			await view.component.scrollToOid("oid-700");
			const visible = {
				...snapshot,
				revision: 2,
				commits: snapshot.commits.filter(({ oid }) => oid !== "oid-1"),
			};

			host.seedGraph(visible);
			view.component.showGraph({
				...visible,
				commits: visible.commits.slice(0, visibilityDepth),
			});
			await setImmediate();
			vi.advanceTimersToNextFrame();
			await tick();

			expect(screen.getByText("commit 700")).toBeInTheDocument();
			expect(view.component.loadedRows()).toBe(visible.commits.length);
		});

		it("accepts a refresh that actually reaches the end of a shorter history", async () => {
			const publishedEnds: boolean[] = [];
			const { view, snapshot } = await openPagedGraph((_, hasMore) =>
				publishedEnds.push(!hasMore),
			);
			await view.component.scrollToOid("oid-240");
			const refresh = host.holdNextReply("refresh_commit_graph");
			await view.rerender({ refreshSignal: 1 });
			expect(await refresh.entered).toMatchObject({ loaded: 440 });
			const shortened = {
				...snapshot,
				revision: 2,
				commits: snapshot.commits.slice(0, 200),
			};
			host.seedGraph(shortened);

			refresh.release(shortened);
			await setImmediate();

			expect(publishedEnds.at(-1)).toBe(true);
			expect(view.component.loadedRows()).toBe(shortened.commits.length);
			expect(host.count("get_commit_graph")).toBe(2);
		});

		it("opens at the HEAD row after two full pages without it", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const headRow = 405;
			const commits = history(420).map((commit, index) => ({
				...commit,
				in_head_chain: index >= headRow,
			}));
			const snapshot = { commits, max_columns: 1, checked: true, revision: 1 };
			const first = host.holdNextReply("get_commit_graph");
			const second = host.holdNextReply("get_commit_graph");
			const view = renderPagedGraph(snapshot);
			await first.entered;

			first.release({ ...snapshot, commits: commits.slice(0, 200) });
			await setImmediate();
			expect(latestPageArgs()).toMatchObject({ offset: 200 });
			followViewportScroll(graphViewport(view.container));
			second.release({ ...snapshot, commits: commits.slice(200, 400) });
			await setImmediate();
			vi.advanceTimersToNextFrame();
			await tick();

			expect(screen.queryByText(`commit ${headRow}`)).toBeInTheDocument();
		});

		it("keeps the graph depth when the same hidden commit is requested twice", async () => {
			const { view } = await openPagedGraph();

			await view.component.scrollToOid("hidden-topic");
			await view.component.scrollToOid("hidden-topic");

			expect(view.component.loadedRows()).toBe(200);
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			expect(host.count("get_commit_graph")).toBe(3);
		});

		it("loads a visible target after sharing a page for a hidden target", async () => {
			const { view } = await openPagedGraph();
			const page = host.holdNextReply("get_commit_graph");
			const hidden = view.component.scrollToOid("hidden-topic");
			await page.entered;

			const visible = view.component.scrollToOid("oid-240");
			page.release(null);
			await Promise.all([hidden, visible]);

			expect(view.component.loadedRows()).toBe(440);
			expect(latestPageArgs()).toMatchObject({
				offset: 200,
				revision: 1,
				through: "oid-240",
			});
		});

		it("resumes infinite scroll after sharing a page for a hidden target", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			const { view } = await openPagedGraph();
			const page = host.holdNextReply("get_commit_graph");
			const jump = view.component.scrollToOid("hidden-topic");
			await page.entered;

			await fireEvent.scroll(graphViewport(view.container), {
				target: { scrollTop: 160 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await tick();
			expect(screen.getByText("commit 160")).toBeInTheDocument();
			expect(host.count("get_commit_graph")).toBe(2);
			page.release(null);
			await jump;

			await waitFor(() => expect(view.component.loadedRows()).toBe(400));
			expect(latestPageArgs()).toEqual({
				path: "/repo",
				offset: 200,
				revision: 1,
			});
		});

		it("retries an absent target after a replacement makes it visible", async () => {
			const { view, snapshot } = await openPagedGraph();
			const page = host.holdNextReply("get_commit_graph");
			const oid = "hidden-topic";
			const jump = view.component.scrollToOid(oid);
			await page.entered;

			const commits = snapshot.commits.slice();
			commits.splice(240, 0, makeCommit({ oid }));
			const revealed = { ...snapshot, commits, revision: 2 };
			host.seedGraph(revealed);
			view.component.showGraph({ ...revealed, commits: commits.slice(0, 200) });
			page.release(null);
			await jump;

			expect(view.component.loadedRows()).toBe(440);
			expect(latestPageArgs()).toMatchObject({
				offset: 200,
				revision: 2,
				through: oid,
			});
		});

		function latestPageArgs() {
			return host.requests.findLast(({ cmd }) => cmd === "get_commit_graph")
				?.args;
		}

		async function openPagedGraph(
			oncommitschange?: (
				rows: ReturnType<typeof history>,
				hasMore: boolean,
			) => void,
		) {
			const snapshot = {
				commits: history(840),
				max_columns: 1,
				checked: true,
				revision: 1,
			};
			const view = renderPagedGraph(snapshot, oncommitschange);
			await screen.findByText("commit 0");

			return { view, snapshot };
		}

		function renderPagedGraph(
			snapshot: Parameters<typeof host.seedGraph>[0],
			oncommitschange?: (
				rows: ReturnType<typeof history>,
				hasMore: boolean,
			) => void,
		) {
			host.seedGraph(snapshot);
			return render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
					oncommitschange,
				},
				context: new Map([[SCHEDULER, clock]]),
			});
		}

		function followViewportScroll(viewport: HTMLElement) {
			viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
				const top = typeof options === "number" ? y : options?.top;
				if (top === undefined) return;

				viewport.scrollTop = top;
				viewport.dispatchEvent(new Event("scroll"));
			};
		}
	});

	describe("search responses", () => {
		it.each([
			"new query",
			"next match",
			"close",
			"manual click",
			"arrow navigation",
		] as const)(
			"does not resume an obsolete paged scroll after $0",
			async (gesture) => {
				const commits = [
					makeCommit({ oid: "earlier", summary: "earlier change" }),
					makeCommit({ oid: "latest", summary: "latest change" }),
					...history(198),
				];
				const { view, selections } = await openSearch(commits);
				const scrolls: number[] = [];
				graphViewport(view.container).scrollTo = (
					options?: ScrollToOptions | number,
				) => {
					if (typeof options !== "number") scrolls.push(options?.top ?? 0);
				};
				const page = host.holdNextReply("get_commit_graph");
				host.seedResponse("search_commits", [
					{ oid: "unloaded" },
					{ oid: "latest" },
				]);
				await searchFor("earlier");
				await page.entered;
				expect(selections).toEqual(["unloaded"]);

				if (gesture === "new query") {
					host.seedResponse("search_commits", [{ oid: "latest" }]);
					await searchFor("latest");
				} else if (gesture === "next match") {
					await fireEvent.click(
						screen.getByRole("button", { name: "Next match" }),
					);
				} else if (gesture === "manual click") {
					await fireEvent.click(screen.getByText("latest change"));
				} else if (gesture === "arrow navigation") {
					const graph = screen.getByRole("listbox");
					graph.focus();
					await fireEvent.keyDown(graph, { key: "ArrowDown" });
				} else {
					await fireEvent.click(
						screen.getByRole("button", { name: "Close search" }),
					);
				}
				await drainSearchReplies();
				const expectedScrolls =
					gesture === "new query" || gesture === "next match" ? [0] : [];
				expect(scrolls).toEqual(expectedScrolls);
				if (gesture !== "close")
					expect(selections.at(-1)).toBe(
						gesture === "arrow navigation" ? "earlier" : "latest",
					);
				page.release({
					commits: [
						makeCommit({ oid: "unloaded", summary: "unloaded change" }),
					],
					max_columns: 1,
					checked: true,
					revision: 1,
				});
				await drainSearchReplies();

				expect(scrolls).toEqual(expectedScrolls);
				expect(view.component.loadedRows()).toBe(201);
			},
		);

		it("shows no match count until the search answers", async () => {
			await openSearch();
			const read = host.holdNextReply("search_commits");

			await searchFor("earlier");
			await read.entered;

			expect(screen.queryByText("0 matches")).toBeNull();
		});

		it("reports a current search failure", async () => {
			await openSearch();
			const read = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await read.entered;

			read.reject({ code: "git_error", message: "search unavailable" });
			await drainSearchReplies();

			expect(toasts.items).toContainEqual(
				expect.objectContaining({
					kind: "error",
					message: "search unavailable",
				}),
			);
			expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
			expect(screen.queryByText("0 matches")).toBeNull();
		});

		it.each(["search result", "ordinary navigation"] as const)(
			"finishes a current paged scroll for $0",
			async (navigation) => {
				const { view } = await openSearch([
					makeCommit({ oid: "earlier", summary: "earlier change" }),
					...history(199),
				]);
				const scrolls: number[] = [];
				graphViewport(view.container).scrollTo = (
					options?: ScrollToOptions | number,
				) => {
					if (typeof options !== "number") scrolls.push(options?.top ?? 0);
				};
				const page = host.holdNextReply("get_commit_graph");
				if (navigation === "search result") {
					host.seedResponse("search_commits", [{ oid: "unloaded" }]);
					await searchFor("earlier");
				} else {
					void view.component.scrollToOid("unloaded");
					await fireEvent.click(
						screen.getByRole("button", { name: "Close search" }),
					);
				}
				await page.entered;

				page.release({
					commits: [
						makeCommit({ oid: "unloaded", summary: "unloaded change" }),
					],
					max_columns: 1,
					checked: true,
					revision: 1,
				});
				await drainSearchReplies();

				expect(scrolls).toEqual([200 * ROW_HEIGHT - 100 + ROW_HEIGHT / 2]);
			},
		);

		it("scrolls to the next unloaded match after an earlier page lands", async () => {
			const { view, selections } = await openSearch([
				makeCommit({ oid: "earlier", summary: "earlier change" }),
				...history(199),
			]);
			const scrolls = recordScrolls(view.container);
			host.seedResponse("search_commits", [{ oid: "first" }, { oid: "next" }]);
			const firstPage = host.holdNextReply("get_commit_graph");
			const nextPage = host.holdNextReply("get_commit_graph");
			await searchFor("change");
			await firstPage.entered;

			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			firstPage.release({
				commits: [makeCommit({ oid: "first" }), ...history(398).slice(199)],
				max_columns: 1,
				checked: true,
				revision: 1,
			});
			nextPage.release({
				commits: [makeCommit({ oid: "next" })],
				max_columns: 1,
				checked: true,
				revision: 1,
			});
			await drainSearchReplies();

			expect(selections).toEqual(["first", "next"]);
			expect(scrolls).toEqual([400 * ROW_HEIGHT - 100 + ROW_HEIGHT / 2]);
			expect(host.count("get_commit_graph")).toBe(3);
			expect(await nextPage.entered).toMatchObject({
				offset: 400,
				through: "next",
			});
		});

		it("scrolls to the newer jump when the active page already contains it", async () => {
			const { view } = await openSearch([
				makeCommit({ oid: "earlier", summary: "earlier change" }),
				...history(199),
			]);
			const scrolls = recordScrolls(view.container);
			const page = host.holdNextReply("get_commit_graph");
			const firstJump = view.component.scrollToOid("first");
			await page.entered;

			const nextJump = view.component.scrollToOid("next");
			page.release({
				commits: [makeCommit({ oid: "first" }), makeCommit({ oid: "next" })],
				max_columns: 1,
				checked: true,
				revision: 1,
			});
			await Promise.all([firstJump, nextJump]);

			expect(scrolls).toEqual([201 * ROW_HEIGHT - 100 + ROW_HEIGHT / 2]);
			expect(host.count("get_commit_graph")).toBe(2);
		});

		it("keeps the latest query's results when an earlier reply arrives last", async () => {
			const { selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			const latest = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;
			await searchFor("latest");
			await latest.entered;
			latest.release([{ oid: "latest" }]);
			await drainSearchReplies();

			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual(["latest"]);
			expect(screen.getByText("1 of 1")).toBeVisible();
		});

		it.each(["results", "error"] as const)(
			"drops a stale search $0 after graph replacement and keeps selection",
			async (outcome) => {
				const { view, selections } = await openSearch();
				const earlier = host.holdNextReply("search_commits");
				const refreshed = host.holdNextReply("search_commits");
				const settleObsolete = {
					results: () => earlier.release([{ oid: "earlier" }]),
					error: () =>
						earlier.reject({
							code: "git_error",
							message: "old graph unavailable",
						}),
				};
				await searchFor("change");
				await earlier.entered;
				await fireEvent.click(screen.getByText("latest change"));

				const replacement = {
					commits: [makeCommit({ oid: "latest", summary: "latest change" })],
					max_columns: 1,
					checked: true,
					revision: 2,
				};
				view.component.showGraph(replacement);
				view.component.showGraph(replacement);
				settleObsolete[outcome]();
				await drainSearchReplies();

				expect(selections).toEqual(["latest"]);
				expect(toasts.items).toEqual([]);
				expect(
					screen.getByRole("button", { name: "Next match" }),
				).toBeDisabled();
				expect(host.count("search_commits")).toBe(2);
				expect(await refreshed.entered).toEqual({
					path: "/repo",
					query: "change",
					revision: 2,
				});

				refreshed.release([{ oid: "latest" }]);
				await drainSearchReplies();

				expect(screen.getByText("1 of 1")).toBeVisible();
				expect(selections).toEqual(["latest"]);
			},
		);

		it("keeps the typing debounce when the graph changes before the search starts", async () => {
			const commits = [makeCommit({ oid: "latest", summary: "latest change" })];
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [{ oid: "latest" }]);
			await fireEvent.input(screen.getByPlaceholderText("Search commits…"), {
				target: { value: "change" },
			});
			await vi.advanceTimersByTimeAsync(150);

			view.component.showGraph({
				commits,
				max_columns: 1,
				checked: true,
				revision: 2,
			});
			await drainSearchReplies();
			expect(host.count("search_commits")).toBe(0);
			await vi.advanceTimersByTimeAsync(50);

			expect(host.count("search_commits")).toBe(1);
			expect(selections).toEqual(["latest"]);
		});

		it("jumps to the first match when a replacement graph answers the initial query", async () => {
			const { view, selections } = await openSearch();
			const initial = host.holdNextReply("search_commits");
			const replacement = host.holdNextReply("search_commits");
			await searchFor("change");

			view.component.showGraph(searchGraph(2, ["latest"]));
			await replacement.entered;
			initial.release([{ oid: "earlier" }]);
			replacement.release([{ oid: "latest" }]);
			await drainSearchReplies();

			expect(screen.getByText("1 of 1")).toBeVisible();
			expect(selections).toEqual(["latest"]);
		});

		it.each([
			"row click",
			"graph key",
			"replacement before row click",
		] as const)(
			"keeps the selection made by a %s while the initial search is held",
			async (gesture) => {
				const { view, selections } = await openSearch();
				let answer = host.holdNextReply("search_commits");
				await searchFor("change");
				await answer.entered;
				const navigate = {
					"row click": () =>
						fireEvent.click(screen.getByText("earlier change")),
					"graph key": async () => {
						const graph = screen.getByRole("listbox");
						graph.focus();
						await fireEvent.keyDown(graph, { key: "Home" });
					},
					"replacement before row click": async () => {
						const obsolete = answer;
						answer = host.holdNextReply("search_commits");
						view.component.showGraph(searchGraph(2, ["earlier", "latest"]));
						await answer.entered;
						obsolete.release([{ oid: "latest" }]);
						await fireEvent.click(screen.getByText("earlier change"));
					},
				};

				await navigate[gesture]();
				answer.release([{ oid: "latest" }]);
				await drainSearchReplies();

				expect(screen.getByText("1 of 1")).toBeVisible();
				expect(selections).toEqual(["earlier"]);
			},
		);

		it("drops a reply when the query changes before its next debounce", async () => {
			const { selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			await fireEvent.input(screen.getByPlaceholderText("Search commits…"), {
				target: { value: "latest" },
			});
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
			expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
		});

		it("drops a reply after the query is cleared", async () => {
			const { selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			await searchFor("");
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
			expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
		});

		it("drops a reply after search closes", async () => {
			const { selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			await fireEvent.click(
				screen.getByRole("button", { name: "Close search" }),
			);
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
		});

		it("drops a reply across deactivation and reactivation", async () => {
			const { view, selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			await view.rerender({ tabActive: false });
			await view.rerender({ tabActive: true });
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
		});

		it("runs a search the tab left unanswered when the tab returns", async () => {
			const { view, selections } = await openSearch();
			host.holdNextReply("search_commits");
			await searchFor("earlier");
			await view.rerender({ tabActive: false });
			host.seedResponse("search_commits", [{ oid: "earlier" }]);

			await view.rerender({ tabActive: true });
			await vi.advanceTimersByTimeAsync(200);
			await drainSearchReplies();

			expect(selections).toEqual(["earlier"]);
			expect(screen.getByText("1 of 1")).toBeVisible();
		});

		it("drops a reply across repository changes", async () => {
			const { view, selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			await view.rerender({ repoPath: "/other" });
			await view.rerender({ repoPath: "/repo" });
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
		});

		it("drops a reply after the graph unmounts", async () => {
			const { view, selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;

			view.unmount();
			earlier.release([{ oid: "earlier" }]);
			await drainSearchReplies();

			expect(selections).toEqual([]);
		});

		it("keeps newer results when an earlier request fails", async () => {
			const { selections } = await openSearch();
			const earlier = host.holdNextReply("search_commits");
			const latest = host.holdNextReply("search_commits");
			await searchFor("earlier");
			await earlier.entered;
			await searchFor("latest");
			await latest.entered;
			latest.release([{ oid: "latest" }, { oid: "earlier" }]);
			await drainSearchReplies();

			earlier.reject({ code: "git_error", message: "search unavailable" });
			await drainSearchReplies();

			expect(selections).toEqual(["latest"]);
			expect(screen.getByText("1 of 2")).toBeVisible();
			expect(toasts.items).toEqual([]);
		});

		it("preserves completed results across tab activation without another search", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await drainSearchReplies();

			await view.rerender({ tabActive: false });
			await view.rerender({ tabActive: true });
			await vi.advanceTimersByTimeAsync(200);
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));

			expect(host.count("search_commits")).toBe(1);
			expect(selections).toEqual(["latest", "earlier"]);
			expect(screen.getByText("2 of 2")).toBeVisible();
		});

		it("searches again when the graph changes, keeping the current match", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await drainSearchReplies();
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			host.seedResponse("search_commits", [
				{ oid: "newest" },
				{ oid: "latest" },
				{ oid: "earlier" },
			]);

			view.component.showGraph({
				commits: [
					makeCommit({ oid: "newest", summary: "newest change" }),
					makeCommit({ oid: "earlier", summary: "earlier change" }),
					makeCommit({ oid: "latest", summary: "latest change" }),
				],
				max_columns: 1,
				checked: true,
				revision: 2,
			});
			await drainSearchReplies();

			expect(host.count("search_commits")).toBe(2);
			expect(screen.getByText("3 of 3")).toBeVisible();
			expect(selections).toEqual(["latest", "earlier"]);
		});

		it("keeps the current match's place when a rewrite replaces it", async () => {
			const { view } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await drainSearchReplies();
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			host.seedResponse("search_commits", [
				{ oid: "latest-rewritten" },
				{ oid: "earlier-rewritten" },
			]);

			view.component.showGraph({
				commits: [
					makeCommit({ oid: "latest-rewritten", summary: "latest change" }),
					makeCommit({ oid: "earlier-rewritten", summary: "earlier change" }),
				],
				max_columns: 1,
				checked: true,
				revision: 2,
			});
			await drainSearchReplies();

			expect(screen.getByText("2 of 2")).toBeVisible();
		});

		it("keeps the place of a current match that left the end of the results", async () => {
			const { view } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await drainSearchReplies();
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			host.seedResponse("search_commits", [{ oid: "latest" }]);

			view.component.showGraph({
				commits: [makeCommit({ oid: "latest", summary: "latest change" })],
				max_columns: 1,
				checked: true,
				revision: 2,
			});
			await drainSearchReplies();

			expect(screen.getByText("1 of 1")).toBeVisible();
		});

		it("keeps the match the user moves to while the graph's new search runs", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await drainSearchReplies();
			const refreshed = host.holdNextReply("search_commits");
			view.component.showGraph({
				commits: [
					makeCommit({ oid: "earlier", summary: "earlier change" }),
					makeCommit({ oid: "latest", summary: "latest change" }),
				],
				max_columns: 1,
				checked: true,
				revision: 2,
			});
			await refreshed.entered;

			expect(screen.queryByText("1 of 2")).toBeNull();
			expect(view.container.querySelector(".bg-search-current")).toBeNull();
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			expect(selections).toEqual(["latest"]);
			refreshed.release([{ oid: "latest" }, { oid: "earlier" }]);
			await drainSearchReplies();

			expect(screen.getByText("2 of 2")).toBeVisible();
			expect(selections).toEqual(["latest", "earlier"]);
		});

		it("drops a queued Next whose target disappears from the fresh matches", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			const replacement = host.holdNextReply("search_commits");
			view.component.showGraph(searchGraph(2, ["latest"]));
			await replacement.entered;

			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			replacement.release([{ oid: "latest" }]);
			await drainSearchReplies();

			expect(screen.getByText("1 of 1")).toBeVisible();
			expect(selections).toEqual(["latest"]);
		});

		it("keeps obsolete results unavailable when the replacement search fails", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			const replacement = host.holdNextReply("search_commits");
			view.component.showGraph(searchGraph(2, ["latest"]));
			await replacement.entered;

			replacement.reject({ code: "git_error", message: "search unavailable" });
			await drainSearchReplies();
			await fireEvent.keyDown(screen.getByPlaceholderText("Search commits…"), {
				key: "Enter",
			});

			expect(screen.queryByText("1 of 2")).toBeNull();
			expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
			expect(selections).toEqual(["latest"]);
		});

		it("re-searches an answered query when the graph changes in an inactive tab", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await view.rerender({ tabActive: false });
			view.component.showGraph(searchGraph(2, ["latest"]));
			host.seedResponse("search_commits", [{ oid: "latest" }]);

			await view.rerender({ tabActive: true });
			await vi.advanceTimersByTimeAsync(200);
			await drainSearchReplies();

			expect(screen.getByText("1 of 1")).toBeVisible();
			expect(selections).toEqual(["latest"]);
			expect(host.count("search_commits")).toBe(2);
		});

		it("catches up to the cached graph when the host rejects a stale search revision", async () => {
			const { selections } = await openSearch();
			const obsolete = host.holdNextReply("search_commits");
			const cached = host.holdNextReply("get_commit_graph");
			host.seedResponse("search_commits", [{ oid: "latest" }]);
			await searchFor("change");
			await obsolete.entered;

			obsolete.reject({
				code: "graph_changed",
				message: "The graph revision changed",
			});
			await drainSearchReplies();
			expect(host.count("get_commit_graph")).toBe(2);
			cached.release(searchGraph(2, ["latest"]));
			await drainSearchReplies();

			expect(screen.getByText("1 of 1")).toBeVisible();
			expect(selections).toEqual(["latest"]);
			expect(toasts.items).toEqual([]);
		});

		it("keeps a queued match step through a rejected revision and selects it from the next answer", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			const replacement = host.holdNextReply("search_commits");
			const cached = host.holdNextReply("get_commit_graph");
			view.component.showGraph(searchGraph(2, ["earlier", "latest"]));
			await replacement.entered;
			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));

			replacement.reject({
				code: "graph_changed",
				message: "The graph revision changed",
			});
			await cached.entered;
			cached.release(searchGraph(3, ["earlier", "latest"]));
			await drainSearchReplies();

			expect(selections).toEqual(["latest", "earlier"]);
			expect(screen.getByText("2 of 2")).toBeVisible();
		});

		it("withholds the old matches while an inactive tab catches up to a known revision", async () => {
			const { view, selections } = await openSearch();
			host.seedResponse("search_commits", [
				{ oid: "latest" },
				{ oid: "earlier" },
			]);
			await searchFor("change");
			await view.rerender({ tabActive: false });
			await view.rerender({ cachedGraphRevision: 2 });
			const cached = host.holdNextReply("get_commit_graph");
			host.seedResponse("search_commits", [{ oid: "latest" }]);

			await view.rerender({ tabActive: true });
			await cached.entered;
			await fireEvent.keyDown(screen.getByPlaceholderText("Search commits…"), {
				key: "Enter",
			});

			expect(screen.queryByText(/of 2/)).toBeNull();
			expect(selections).toEqual(["latest"]);
			cached.release(searchGraph(2, ["latest"]));
			await vi.advanceTimersByTimeAsync(200);
			await drainSearchReplies();
			expect(screen.getByText("1 of 1")).toBeVisible();
		});

		it("can page to a known fresh match immediately after tab return", async () => {
			const { view } = await openSearch([
				makeCommit({ oid: "earlier", summary: "earlier change" }),
				...history(199),
			]);
			host.seedResponse("search_commits", [
				{ oid: "earlier" },
				{ oid: "unloaded" },
			]);
			await searchFor("change");
			await view.rerender({ tabActive: false });
			await view.rerender({ tabActive: true });
			const page = host.holdNextReply("get_commit_graph");
			const scrolls = recordScrolls(view.container);

			await fireEvent.click(screen.getByRole("button", { name: "Next match" }));
			await page.entered;
			await vi.advanceTimersByTimeAsync(200);
			page.release(searchGraph(1, ["unloaded"]));
			await drainSearchReplies();

			expect(scrolls).toEqual([200 * ROW_HEIGHT - 100 + ROW_HEIGHT / 2]);
			expect(host.count("search_commits")).toBe(1);
		});

		it("cancels a search debounce when the tab becomes inactive", async () => {
			const { view } = await openSearch();
			await fireEvent.input(screen.getByPlaceholderText("Search commits…"), {
				target: { value: "earlier" },
			});

			await view.rerender({ tabActive: false });
			await vi.advanceTimersByTimeAsync(200);

			expect(host.count("search_commits")).toBe(0);
		});

		async function openSearch(
			commits = [
				makeCommit({ oid: "earlier", summary: "earlier change" }),
				makeCommit({ oid: "latest", summary: "latest change" }),
			],
		) {
			const selections: string[] = [];
			host.seedGraph({
				commits,
				max_columns: 1,
				checked: true,
				revision: 1,
			});
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
					oncommitselect: (oid) => selections.push(oid),
				},
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("earlier change");
			view.component.openFind();
			await screen.findByPlaceholderText("Search commits…");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

			return { view, selections };
		}

		function searchGraph(revision: number, oids: readonly string[]) {
			return {
				commits: oids.map((oid) =>
					makeCommit({ oid, summary: `${oid} change` }),
				),
				max_columns: 1,
				checked: true,
				revision,
			};
		}

		async function searchFor(query: string): Promise<void> {
			await fireEvent.input(screen.getByPlaceholderText("Search commits…"), {
				target: { value: query },
			});
			await vi.advanceTimersByTimeAsync(200);
		}

		async function drainSearchReplies(): Promise<void> {
			await setImmediate();
			await tick();
		}

		function recordScrolls(container: HTMLElement): number[] {
			const scrolls: number[] = [];
			graphViewport(container).scrollTo = (
				options?: ScrollToOptions | number,
			) => {
				if (typeof options !== "number") scrolls.push(options?.top ?? 0);
			};
			return scrolls;
		}
	});

	it("runs a completed command catch-up without advancing the refresh timer", async () => {
		host.seedGraph(graph(1));
		render(GraphRefreshHarness, {
			props: { refreshImmediately: true, commandTarget: "graph" },
			context: new Map([[SCHEDULER, clock]]),
		});
		await screen.findByText("revision 1");
		const first = host.holdNextReply("refresh_commit_graph");
		const second = host.holdNextReply("refresh_commit_graph");

		await fireEvent.click(screen.getByText("Complete command"));
		await first.entered;
		await fireEvent.click(screen.getByText("Complete command"));
		expect(host.count("refresh_commit_graph")).toBe(1);
		first.release(graph(2));
		await second.entered;
		second.release(graph(3));

		await screen.findByText("revision 3");
		expect(host.count("refresh_commit_graph")).toBe(2);
		expect(screen.queryByText("revision 2")).toBeNull();
	});

	it.each(["get_wip_diff_stats", "list_stashes"])(
		"runs a completed command's busy %s catch-up without a refresh timer",
		async (command) => {
			host.preferences.set("column_visibility", { diff: true });
			host.seedGraph(graph(1));
			const response =
				command === "list_stashes"
					? []
					: {
							files_changed: 1,
							insertions: 1,
							deletions: 0,
						};
			host.seedResponse(command, response);
			render(GraphRefreshHarness, {
				props: { refreshImmediately: true, commandTarget: "worktree" },
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("revision 1");
			await waitFor(() => expect(host.count(command)).toBeGreaterThan(0));
			const before = host.count(command);
			const first = host.holdNextReply(command);
			const second = host.holdNextReply(command);

			await fireEvent.click(screen.getByText("Complete command"));
			await first.entered;
			await fireEvent.click(screen.getByText("Complete command"));
			expect(host.count(command)).toBe(before + 1);
			first.release(response);
			await second.entered;
			second.release(response);

			expect(host.count(command)).toBe(before + 2);
		},
	);

	describe("visible graph statistics", () => {
		it("defers stats for a hidden Diff column and loads them when shown", async () => {
			host.preferences.set("column_visibility", { diff: false });
			host.seedGraph(graph(1));
			host.seedResponse("get_commit_stats", {
				head: { files_changed: 1, insertions: 7, deletions: 0 },
			});
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
				},
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
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: false,
				},
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
			host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
			host.seedResponse("get_commit_stats", stats(commits.slice(32)));
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
				},
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
			host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
			host.seedResponse("get_commit_stats", stats(commits));
			const first = host.holdNextReply("get_commit_stats");
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
				},
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
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: false,
				},
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
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
				},
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
			host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
			host.seedResponse(
				"get_commit_stats",
				stats(commits.filter((_, i) => i !== 55)),
			);
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
				},
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
			host.seedGraph({ commits, max_columns: 1, revision: 1, checked: true });
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
			checked: true,
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

	describe("arrow navigation", () => {
		it("brings the next commit back into view after the list was scrolled away", async () => {
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			host.seedGraph({
				commits: history(150),
				max_columns: 1,
				revision: 1,
				checked: true,
			});
			const view = render(CommitGraph, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					remoteState: createRemoteState(),
					tabActive: true,
					selectedCommitOid: "oid-0",
				},
				context: new Map([[SCHEDULER, clock]]),
			});
			await screen.findByText("commit 0");
			vi.advanceTimersToNextFrame();
			await tick();
			const viewport = graphViewport(view.container);
			await fireEvent.scroll(viewport, {
				target: { scrollTop: 70 * ROW_HEIGHT },
			});
			vi.advanceTimersToNextFrame();
			await tick();
			const scrolls: number[] = [];
			viewport.scrollTo = (options?: ScrollToOptions | number) => {
				if (typeof options !== "number") scrolls.push(options?.top ?? 0);
			};

			await fireEvent.keyDown(screen.getByRole("listbox"), {
				key: "ArrowDown",
			});
			await tick();

			expect(scrolls).toEqual([ROW_HEIGHT]);
		});
	});

	describe("page and edge keys", () => {
		const rowsInView = Math.floor(200 / ROW_HEIGHT) - 1;

		it.each([
			{ key: "PageDown", from: 40, to: 40 + rowsInView },
			{ key: "PageUp", from: 40, to: 40 - rowsInView },
			{ key: "Home", from: 40, to: 0 },
			{ key: "End", from: 40, to: 149 },
		])(
			"moves the selection from row $from to row $to on $key",
			async ({ key, from, to }) => {
				host.seedGraph({
					commits: history(150),
					max_columns: 1,
					revision: 1,
					checked: true,
				});
				const navigated: string[] = [];
				render(CommitGraph, {
					props: {
						...noReviewCounts(),
						repoPath: "/repo",
						remoteState: createRemoteState(),
						tabActive: true,
						selectedCommitOid: `oid-${from}`,
						oncommitnavigate: (oid: string) => navigated.push(oid),
					},
					context: new Map([[SCHEDULER, clock]]),
				});
				await screen.findByText("commit 0");

				await fireEvent.keyDown(screen.getByRole("listbox"), { key });

				expect(navigated).toEqual([`oid-${to}`]);
			},
		);
	});

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
		const graph = {
			commits: [commit],
			max_columns: 1,
			revision: 2,
			checked: true,
		};
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
				diffPreferences: DiffPreferences.defaults(),
				remoteState: createRemoteState(),
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
