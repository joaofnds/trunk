import { MenuItem } from "@tauri-apps/api/menu";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCommit, makeRef } from "../__tests__/helpers/factories";
import { safeInvoke } from "../lib/invoke.js";
import { resetCache } from "../lib/text-measure.js";
import CommitGraph from "./CommitGraph.svelte";

// Stub OffscreenCanvas for jsdom — used by text-measure.ts (measureTextWidth).
// Widths are per-glyph rather than uniform so that two equal-length strings can
// still measure differently, as they do in the real proportional font.
const WIDE_GLYPH = /[0-9mwMW]/;
function stubTextWidth(text: string): number {
	return [...text].reduce((w, ch) => w + (WIDE_GLYPH.test(ch) ? 10 : 6), 0);
}
if (typeof globalThis.OffscreenCanvas === "undefined") {
	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return {
				font: "",
				measureText: (text: string) => ({ width: stubTextWidth(text) }),
			};
		}
	} as unknown as typeof OffscreenCanvas;
}

// Stub Element.scrollTo for jsdom — VirtualList uses viewport.scrollTo()
if (typeof Element.prototype.scrollTo === "undefined") {
	Element.prototype.scrollTo = () => {};
}

// Mock safeInvoke at the wrapper layer so tests can dispatch by command name and
// reject with TrunkError shapes for the WR-02 error branching tests.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(),
	};
});

vi.mock("../lib/toast.svelte.js", () => ({
	showToast: vi.fn(),
}));

// search-toggle is webview-global, so every mounted instance gets one and the
// fire helper calls them all.
let searchToggleHandlers: (() => void)[] = [];
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, cb: () => void) => {
		if (event === "search-toggle") searchToggleHandlers.push(cb);
		return Promise.resolve(() => {});
	}),
}));

function fireSearchToggle(): void {
	for (const handler of searchToggleHandlers) handler();
}

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
	message: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		onResized: vi.fn().mockResolvedValue(() => {}),
		onMoved: vi.fn().mockResolvedValue(() => {}),
		isMaximized: vi.fn().mockResolvedValue(false),
		isFullscreen: vi.fn().mockResolvedValue(false),
	}),
}));

// Capture every menu item's { text -> action } so tests can invoke the exact
// callback the user triggers when picking a context-menu entry. This is the only
// way the merge/revert handlers (wired through Tauri context menus) are reachable
// in jsdom; firing the captured action IS the observable user behavior.
const menuActions = new Map<string, () => unknown>();
function getMenuAction(text: string): () => unknown {
	const action = menuActions.get(text);
	if (!action) {
		throw new Error(
			`no menu action captured for "${text}"; captured: ${[...menuActions.keys()].join(", ")}`,
		);
	}
	return action;
}
vi.mock("@tauri-apps/api/menu", () => ({
	Menu: {
		new: vi.fn().mockResolvedValue({
			popup: vi.fn().mockResolvedValue(undefined),
		}),
	},
	MenuItem: {
		new: vi.fn((opts: { text: string; action?: () => unknown }) => {
			if (opts.action) menuActions.set(opts.text, opts.action);
			return Promise.resolve({});
		}),
	},
	CheckMenuItem: { new: vi.fn().mockResolvedValue({}) },
	PredefinedMenuItem: { new: vi.fn().mockResolvedValue({}) },
	Submenu: {
		new: vi.fn((opts: { text: string }) => {
			void opts;
			return Promise.resolve({});
		}),
	},
}));

vi.mock("@tauri-apps/plugin-window-state", () => ({}));

const TEST_COMMITS = [
	makeCommit({
		oid: "aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
		summary: "first commit",
		is_head: true,
	}),
	makeCommit({
		oid: "bbb222bbb222bbb2bbb222bbb222bbb2bbb222bb",
		summary: "second commit",
		parent_oids: ["aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa"],
	}),
];

// Install the dispatcher. Reads route by command name; tests override individual
// commands via `extra` (called BEFORE this installer to layer rejections).
type DispatchOverride = (
	cmd: string,
	args?: Record<string, unknown>,
) => unknown | undefined;
function installReads(
	opts: { commits?: typeof TEST_COMMITS; override?: DispatchOverride } = {},
) {
	const commits = opts.commits ?? TEST_COMMITS;
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockImplementation((cmd: string, args) => {
		const overridden = opts.override?.(cmd, args);
		if (overridden !== undefined) return overridden as Promise<unknown>;
		switch (cmd) {
			case "get_commit_graph":
				return Promise.resolve({ commits, max_columns: 1 });
			case "refresh_commit_graph":
				return Promise.resolve({ commits, max_columns: 1 });
			case "list_stashes":
				return Promise.resolve([]);
			default:
				return Promise.resolve(undefined);
		}
	});
}

async function flush() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

beforeEach(() => {
	searchToggleHandlers = [];
	vi.clearAllMocks();
	menuActions.clear();
	resetCache();
	installReads();
});

describe("CommitGraph", () => {
	it("renders without crashing", () => {
		const { container } = render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});
		expect(container).toBeTruthy();
	});

	it("renders column headers", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});
		await waitFor(() => {
			expect(screen.getByText("Branch/Tag")).toBeInTheDocument();
		});
		expect(screen.getByText("Graph")).toBeInTheDocument();
		expect(screen.getByText("Message")).toBeInTheDocument();
		expect(screen.getByText("Author")).toBeInTheDocument();
		expect(screen.getByText("Date")).toBeInTheDocument();
		expect(screen.getByText("SHA")).toBeInTheDocument();
	});

	it("sizes the header row from the shared panel-header height", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});

		const headerRow = (await screen.findByText("Date")).parentElement;

		expect(headerRow?.getAttribute("style")).toContain("height: var(--bar-h)");
	});

	it("renders commit summaries after data loads", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});
		expect(await screen.findByText("first commit")).toBeInTheDocument();
		expect(await screen.findByText("second commit")).toBeInTheDocument();
	});

	it("has listbox role for keyboard navigation", () => {
		const { container } = render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});
		expect(container.querySelector('[role="listbox"]')).toBeTruthy();
	});

	it("calls list_stashes on mount", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				tabActive: true,
			},
		});
		await waitFor(() => {
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("list_stashes", {
				path: "/test/repo",
			});
		});
	});

	describe("merge/revert routing through MessageEditor (76-03)", () => {
		// A non-head commit carrying a local branch ref, plus a head commit on
		// its own branch — the precondition for the "Merge X into Y" menu item
		// (CommitGraph.svelte: clickedBranch && headBranchName).
		const FEATURE_COMMIT = makeCommit({
			oid: "ccc333ccc333ccc3ccc333ccc333ccc3ccc333cc",
			summary: "feature work",
			refs: [makeRef({ short_name: "feature", ref_type: "LocalBranch" })],
		});
		const HEAD_COMMIT = makeCommit({
			oid: "aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
			summary: "main tip",
			is_head: true,
			refs: [
				makeRef({ short_name: "main", ref_type: "LocalBranch", is_head: true }),
			],
		});
		const MERGE_FIXTURE = [HEAD_COMMIT, FEATURE_COMMIT];

		async function openContextMenu(rowIndex: number) {
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.contextMenu(rows[rowIndex]);
			await flush();
		}

		function menuItemOptions(text: string): { enabled?: boolean } {
			const call = vi
				.mocked(MenuItem.new)
				.mock.calls.find((c) => (c[0] as { text: string }).text === text);
			if (!call) throw new Error(`no menu item created for "${text}"`);
			return call[0] as { enabled?: boolean };
		}

		async function openTheMenuOnACommit(inHeadChain: boolean) {
			installReads({
				commits: [
					HEAD_COMMIT,
					makeCommit({
						oid: "ddd444ddd444ddd4ddd444ddd444ddd4ddd444dd",
						summary: "older commit",
						in_head_chain: inHeadChain,
					}),
				],
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
				},
			});
			await openContextMenu(1);
		}

		it("offers an interactive rebase on a commit in HEAD's history", async () => {
			await openTheMenuOnACommit(true);

			expect(menuItemOptions("Interactive Rebase...").enabled).toBe(true);
		});

		it("refuses an interactive rebase on a commit outside HEAD's history", async () => {
			await openTheMenuOnACommit(false);

			expect(menuItemOptions("Interactive Rebase...").enabled).toBe(false);
		});

		it("revert: begin -> editor -> revert_continue with edited message", async () => {
			const onopenmessageeditor = vi.fn().mockResolvedValue("edited revert");
			installReads({
				commits: MERGE_FIXTURE,
				override: (cmd) =>
					cmd === "revert_commit_begin"
						? Promise.resolve({ message: "Revert default" })
						: undefined,
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
					onopenmessageeditor,
				},
			});
			await openContextMenu(0);
			await getMenuAction("Revert")();
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith(
				"revert_commit_begin",
				{
					path: "/test/repo",
					oid: HEAD_COMMIT.oid,
				},
			);
			expect(onopenmessageeditor).toHaveBeenCalledWith(
				"Revert default",
				"Revert commit message",
			);
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("revert_continue", {
				path: "/test/repo",
				message: "edited revert",
			});
		});

		it("revert: cancel (null) does not invoke revert_continue", async () => {
			const onopenmessageeditor = vi.fn().mockResolvedValue(null);
			installReads({
				commits: MERGE_FIXTURE,
				override: (cmd) =>
					cmd === "revert_commit_begin"
						? Promise.resolve({ message: "Revert default" })
						: undefined,
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
					onopenmessageeditor,
				},
			});
			await openContextMenu(0);
			await getMenuAction("Revert")();
			await flush();

			expect(onopenmessageeditor).toHaveBeenCalled();
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"revert_continue",
				expect.anything(),
			);
		});

		it("merge ready: begin -> editor -> merge_continue with edited message", async () => {
			const onopenmessageeditor = vi.fn().mockResolvedValue("edited merge");
			installReads({
				commits: MERGE_FIXTURE,
				override: (cmd) =>
					cmd === "merge_branch_begin"
						? Promise.resolve({ kind: "ready", message: "Merge default" })
						: undefined,
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
					onopenmessageeditor,
				},
			});
			await openContextMenu(1);
			await getMenuAction("Merge feature into main")();
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("merge_branch_begin", {
				path: "/test/repo",
				branch: "refs/heads/feature",
			});
			expect(onopenmessageeditor).toHaveBeenCalledWith(
				"Merge default",
				"Merge commit message",
			);
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("merge_continue", {
				path: "/test/repo",
				message: "edited merge",
			});
		});

		it("merge fast_forwarded: no editor, no merge_continue", async () => {
			const onopenmessageeditor = vi.fn();
			installReads({
				commits: MERGE_FIXTURE,
				override: (cmd) =>
					cmd === "merge_branch_begin"
						? Promise.resolve({ kind: "fast_forwarded" })
						: undefined,
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
					onopenmessageeditor,
				},
			});
			await openContextMenu(1);
			await getMenuAction("Merge feature into main")();
			await flush();

			expect(onopenmessageeditor).not.toHaveBeenCalled();
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"merge_continue",
				expect.anything(),
			);
		});

		it("merge conflicts: no editor opened", async () => {
			const onopenmessageeditor = vi.fn();
			installReads({
				commits: MERGE_FIXTURE,
				override: (cmd) =>
					cmd === "merge_branch_begin"
						? Promise.resolve({ kind: "conflicts" })
						: undefined,
			});
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
					onopenmessageeditor,
				},
			});
			await openContextMenu(1);
			await getMenuAction("Merge feature into main")();
			await flush();

			expect(onopenmessageeditor).not.toHaveBeenCalled();
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"merge_continue",
				expect.anything(),
			);
		});
	});

	// App.svelte keeps every tab mounted in one document, so a document-rooted
	// query returns the first match in DOM order rather than this instance's.
	describe("with a second graph mounted", () => {
		const scrollTargets: Element[] = [];
		const originalScrollTo = Element.prototype.scrollTo;

		beforeEach(() => {
			scrollTargets.length = 0;
			Element.prototype.scrollTo = function scrollTo() {
				scrollTargets.push(this);
			};
		});

		afterEach(() => {
			Element.prototype.scrollTo = originalScrollTo;
		});

		// Only one tab is ever active, so the background graph is the realistic
		// shape for both the focus target and the toggle guard.
		function renderPair() {
			const first = render(CommitGraph, {
				props: {
					repoPath: "/repo/a",
					tabActive: false,
				},
			});
			const second = render(CommitGraph, {
				props: {
					repoPath: "/repo/b",
					tabActive: true,
				},
			});
			return { first, second };
		}

		it("focuses its own search input", async () => {
			const { first, second } = renderPair();
			await flush();

			fireSearchToggle();
			await flush();
			fireSearchToggle();
			await flush();

			expect(second.container.contains(document.activeElement)).toBe(true);
			expect(first.container.contains(document.activeElement)).toBe(false);
		});

		it("leaves a background tab's search closed", async () => {
			const { first } = renderPair();
			await flush();

			fireSearchToggle();
			await flush();

			expect(first.container.querySelectorAll(".search-bar-input").length).toBe(
				0,
			);
		});

		it("centers the row in its own viewport", async () => {
			const { second } = renderPair();
			await flush();
			scrollTargets.length = 0;

			await second.component.scrollToOid(TEST_COMMITS[1].oid);
			await flush();

			expect(second.container.contains(scrollTargets.at(-1) ?? null)).toBe(
				true,
			);
		});
	});

	// CommitRow drops the graph cell when the column is hidden, so the flex-1
	// message cell slides into the band the overlay still painted into.
	describe("hidden graph column", () => {
		function withGraphColumn(graph: boolean) {
			installReads({
				override: (cmd, args) =>
					cmd === "prefs_get" && args?.key === "column_visibility"
						? Promise.resolve({
								ref: true,
								graph,
								message: true,
								diff: true,
								author: true,
								date: true,
								sha: true,
							})
						: undefined,
			});

			return render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
				},
			});
		}

		const count = (container: HTMLElement, selector: string) =>
			container.querySelectorAll(selector).length;

		it("draws the dots when the column is shown", async () => {
			const { container } = withGraphColumn(true);

			await waitFor(() => {
				expect(count(container, ".overlay-dots circle")).toBe(2);
			});
		});

		it("draws no dots or rails when the column is hidden", async () => {
			const { container } = withGraphColumn(false);

			await waitFor(() => {
				expect(screen.getAllByText("first commit").length).toBe(1);
			});
			await flush();

			expect(count(container, ".overlay-dots")).toBe(0);
			expect(count(container, ".overlay-paths")).toBe(0);
		});
	});

	describe("mount scroll anchor", () => {
		function detachedPage() {
			return Array.from({ length: 200 }, (_, i) =>
				makeCommit({
					oid: `${i}`.padStart(40, "0"),
					summary: `commit ${i}`,
					in_head_chain: i >= 3,
				}),
			);
		}

		it("stops paging once the head chain is on screen, HEAD detached", async () => {
			const pages = [detachedPage(), []];
			installReads({
				override: (cmd) =>
					cmd === "get_commit_graph"
						? Promise.resolve({
								commits: pages.shift() ?? [],
								max_columns: 1,
							})
						: undefined,
			});

			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
				},
			});
			await waitFor(() => {
				expect(screen.getByText("commit 3")).toBeInTheDocument();
			});
			await flush();

			const graphCalls = vi
				.mocked(safeInvoke)
				.mock.calls.filter(([cmd]) => cmd === "get_commit_graph");
			expect(graphCalls).toHaveLength(1);
		});
	});

	describe("out-of-order refreshes", () => {
		const props = (refreshSignal: number) => ({
			repoPath: "/test/repo",
			tabActive: true,
			refreshSignal,
		});

		function graphPage(summary: string, oidChar: string) {
			return {
				commits: [makeCommit({ oid: oidChar.repeat(40), summary })],
				max_columns: 1,
			};
		}

		it("keeps the newest layout when an older refresh resolves last", async () => {
			const pending: ((page: unknown) => void)[] = [];
			installReads({
				override: (cmd) =>
					cmd === "refresh_commit_graph"
						? new Promise((resolve) => pending.push(resolve))
						: undefined,
			});
			const { rerender } = render(CommitGraph, { props: props(0) });
			await waitFor(() => {
				expect(screen.getByText("first commit")).toBeInTheDocument();
			});
			await rerender(props(1));
			await flush();
			await rerender(props(2));
			await flush();
			expect(pending).toHaveLength(2);

			pending[1](graphPage("fresh refresh", "f"));
			await flush();
			pending[0](graphPage("stale refresh", "5"));
			await flush();

			expect(screen.getByText("fresh refresh")).toBeInTheDocument();
			expect(screen.queryByText("stale refresh")).not.toBeInTheDocument();
		});
	});

	// git resolves a bare shorthand under DWIM, which tries refs/tags before
	// refs/heads and refs/remotes. A hostile repo carrying a tag literally named
	// `origin/feature` therefore captures every action aimed at the branch pill
	// reading `origin/feature`. Sending the fully-qualified ref removes the choice.
	describe("ref identity sent to the backend", () => {
		const SHADOWED = makeRef({
			short_name: "origin/feature",
			name: "refs/remotes/origin/feature",
			ref_type: "RemoteBranch",
		});
		const FEATURE = makeRef({
			short_name: "feature",
			name: "refs/heads/feature",
			ref_type: "LocalBranch",
		});
		const HEAD_COMMIT = makeCommit({
			oid: "aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
			summary: "main tip",
			is_head: true,
			refs: [
				makeRef({ short_name: "main", ref_type: "LocalBranch", is_head: true }),
			],
		});
		const BRANCH_COMMIT = makeCommit({
			oid: "ccc333ccc333ccc3ccc333ccc333ccc3ccc333cc",
			summary: "topic work",
			refs: [FEATURE],
		});
		const REMOTE_COMMIT = makeCommit({
			oid: "ddd444ddd444ddd4ddd444ddd444ddd4ddd444dd",
			summary: "remote work",
			refs: [SHADOWED],
		});

		async function mountGraph() {
			installReads({ commits: [HEAD_COMMIT, BRANCH_COMMIT, REMOTE_COMMIT] });
			render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					tabActive: true,
				},
			});
			await screen.findAllByTestId("commit-row");
			await flush();
		}

		// The canvas stub measures every string at the same width, so long labels
		// come back truncated — match the pill by its surviving prefix.
		async function findPill(labelPrefix: string) {
			return await screen.findByText(new RegExp(`^${labelPrefix}`));
		}

		async function openRowMenu() {
			await mountGraph();
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.contextMenu(rows[1]);
			await flush();
		}

		it("merges the fully-qualified ref, not the shorthand", async () => {
			await openRowMenu();

			await getMenuAction("Merge feature into main")();
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("merge_branch_begin", {
				path: "/test/repo",
				branch: "refs/heads/feature",
			});
		});

		it("rebases onto the fully-qualified ref, not the shorthand", async () => {
			await openRowMenu();

			await getMenuAction("Rebase main onto feature")();
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("rebase_branch", {
				path: "/test/repo",
				ontoBranch: "refs/heads/feature",
			});
		});

		it("branches a remote checkout from the fully-qualified ref", async () => {
			await mountGraph();

			await fireEvent.dblClick(await findPill("origin"));
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("create_branch", {
				path: "/test/repo",
				name: "feature",
				fromOid: "refs/remotes/origin/feature",
			});
		});

		it("detects the fork point from the fully-qualified ref", async () => {
			await mountGraph();

			await fireEvent.contextMenu(await findPill("feature"));
			await flush();
			await getMenuAction("Interactive Rebase feature...")();
			await flush();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("get_fork_point", {
				path: "/test/repo",
				branch: "refs/heads/feature",
			});
		});
	});

	// A scroll-driven page load reads the graph as it was before a rebuild. If it
	// lands after the rebuild, its commits describe a layout that no longer
	// exists, and appending them mixes two graphs in one list.
	//
	// VirtualList renders only a window, so a loaded row is not necessarily in the
	// DOM. What the list holds is observed through scrollToOid, which scrolls only
	// for a commit it can find and pages in more history when it cannot.
	describe("a page load in flight across a rebuild", () => {
		const BATCH = 200;
		const scrollTargets: Element[] = [];
		const originalScrollTo = Element.prototype.scrollTo;

		beforeEach(() => {
			scrollTargets.length = 0;
			Element.prototype.scrollTo = function scrollTo() {
				scrollTargets.push(this);
			};
		});

		afterEach(() => {
			Element.prototype.scrollTo = originalScrollTo;
		});

		// in_head_chain on page one, or the mount anchor effect pages forever
		// looking for the head row and the run never terminates.
		function page(from: number, tag: string) {
			return Array.from({ length: BATCH }, (_, i) =>
				makeCommit({
					oid: oidOf(from + i, tag),
					summary: `${tag} commit ${from + i}`,
					in_head_chain: from === 0,
				}),
			);
		}

		// The tag is in the oid, so a row from the old layout is never mistaken
		// for the row that replaced it at the same index.
		function oidOf(row: number, tag: string) {
			return `${tag}${row}`.padStart(40, "0");
		}

		/** Whether the loaded list holds this commit: scrollToOid scrolls only if
		 *  it can find it, and pages no further once the graph is exhausted. */
		async function isLoaded(
			rendered: Awaited<ReturnType<typeof mountWithPageTwoPending>>["rendered"],
			oid: string,
		) {
			scrollTargets.length = 0;
			await rendered.component.scrollToOid(oid);
			await flush();
			return scrollTargets.length > 0;
		}

		// Page two is held open so the test decides when it lands.
		async function mountWithPageTwoPending() {
			const pending: ((page: unknown) => void)[] = [];
			installReads({
				override: (cmd, args) => {
					if (cmd !== "get_commit_graph") return undefined;
					if (args?.offset === 0) {
						return Promise.resolve({
							commits: page(0, "old"),
							max_columns: 1,
						});
					}
					return new Promise((resolve) => pending.push(resolve));
				},
			});

			const rendered = render(CommitGraph, {
				props: { repoPath: "/test/repo", tabActive: true },
			});
			await waitFor(() => {
				expect(screen.getByText("old commit 0")).toBeInTheDocument();
			});
			// Reaching for a commit page one does not hold starts the page-two load.
			void rendered.component.scrollToOid(oidOf(BATCH, "old"));
			await flush();
			expect(pending).toHaveLength(1);

			return { rendered, pending };
		}

		function rebuildWith(
			rendered: Awaited<ReturnType<typeof mountWithPageTwoPending>>["rendered"],
		) {
			rendered.component.showGraph({
				commits: page(0, "new"),
				max_columns: 1,
			});
		}

		function resolveStalePage(pending: ((page: unknown) => void)[]) {
			pending[0]({ commits: page(BATCH, "old"), max_columns: 1 });
		}

		it("drops a page that describes the graph it replaced", async () => {
			const { rendered, pending } = await mountWithPageTwoPending();

			rebuildWith(rendered);
			await flush();
			// The pre-rebuild request resolves only now.
			resolveStalePage(pending);
			await flush();

			expect(await isLoaded(rendered, oidOf(BATCH, "old"))).toBe(false);
		});

		it("still reaches the pages the rebuilt graph does have", async () => {
			const { rendered, pending } = await mountWithPageTwoPending();

			rebuildWith(rendered);
			await flush();
			resolveStalePage(pending);
			await flush();

			// offset must still index the new layout, so the request the viewport
			// re-issues asks for its page two and the rows become reachable.
			resolveStalePage(pending);
			await flush();
			pending.at(-1)?.({ commits: page(BATCH, "new"), max_columns: 1 });
			await flush();

			expect(await isLoaded(rendered, oidOf(BATCH, "new"))).toBe(true);
		});

		it("appends a page that no rebuild interrupted", async () => {
			const { rendered, pending } = await mountWithPageTwoPending();

			resolveStalePage(pending);
			await flush();

			expect(await isLoaded(rendered, oidOf(BATCH, "old"))).toBe(true);
		});
	});
});
