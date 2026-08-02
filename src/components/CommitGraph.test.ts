import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCommit, makeRef } from "../__tests__/helpers/factories";
import { safeInvoke } from "../lib/invoke.js";
import { relativeLabel } from "../lib/relative-time.js";
import { resetCache } from "../lib/text-measure.js";
import { showToast } from "../lib/toast.svelte.js";
import type { SessionStatus } from "../lib/types.js";
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

// Every label relativeLabel can emit, derived from the formatter rather than
// copied, so a new or reworded bucket joins the width expectation automatically.
const NOW_MINUTE = 30_000_000;
const LABEL_VOCABULARY = [
	0, 1, 59, 60, 1439, 1440, 43199, 43200, 525599, 525600, 5_256_000,
].map((minutesAgo) =>
	relativeLabel((NOW_MINUTE - minutesAgo) * 60, NOW_MINUTE),
);

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

// Capture the session-changed handler so tests can simulate cross-tab emits.
// CommitGraph also registers a search-toggle listener; filter by event name.
let sessionChangedHandler: ((event: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, cb: (event: { payload: string }) => void) => {
		if (event === "session-changed") sessionChangedHandler = cb;
		return Promise.resolve(() => {
			if (event === "session-changed") sessionChangedHandler = null;
		});
	}),
}));

function fireSessionChanged(payload: string): void {
	sessionChangedHandler?.({ payload });
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
type DispatchOverride = (cmd: string) => unknown | undefined;
function installReads(
	opts: {
		commits?: typeof TEST_COMMITS;
		status?: SessionStatus | null;
		sessionCommits?: { oid: string }[];
		override?: DispatchOverride;
	} = {},
) {
	const status = opts.status;
	const commits = opts.commits ?? TEST_COMMITS;
	const sessionCommits = opts.sessionCommits ?? [];
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
		const overridden = opts.override?.(cmd);
		if (overridden !== undefined) return overridden as Promise<unknown>;
		switch (cmd) {
			case "get_commit_graph":
				return Promise.resolve({ commits, max_columns: 1 });
			case "refresh_commit_graph":
				return Promise.resolve({ commits, max_columns: 1 });
			case "list_stashes":
				return Promise.resolve([]);
			case "get_review_session_status":
				return status === null
					? Promise.reject({ code: "no_session", message: "no session" })
					: Promise.resolve(
							status ?? {
								state: "none",
								file_exists: false,
								canonical_path: "/repo",
							},
						);
			case "list_session_commits":
				return Promise.resolve(sessionCommits);
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
	sessionChangedHandler = null;
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
				clearRedoStack: vi.fn(),
			},
		});
		expect(container).toBeTruthy();
	});

	it("renders column headers", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				clearRedoStack: vi.fn(),
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

	it("renders commit summaries after data loads", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				clearRedoStack: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("get_commit_graph", {
				path: "/test/repo",
				offset: 0,
			});
		});
	});

	it("has listbox role for keyboard navigation", () => {
		const { container } = render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				clearRedoStack: vi.fn(),
			},
		});
		expect(container.querySelector('[role="listbox"]')).toBeTruthy();
	});

	it("calls list_stashes on mount", async () => {
		render(CommitGraph, {
			props: {
				repoPath: "/test/repo",
				clearRedoStack: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("list_stashes", {
				path: "/test/repo",
			});
		});
	});

	describe("session-changed listener (66/WR-01)", () => {
		it("fails closed when canonicalPath is null — cross-repo event does not trigger reload", async () => {
			// status reject => sessionStatus stays null AND canonicalPath stays null.
			// Today the bug: `if (sessionStatus && …) return` short-circuits to falsy,
			// so the guard never triggers, and every cross-repo event triggers a reload.
			// After the fix: `canonicalPath && …` is still null/falsy, but the listener
			// uses canonicalPath (fail-closed because canonicalPath null means "we don't
			// know yet — drop everything"). Plan §1 reverses the polarity by requiring
			// the listener to gate on canonicalPath being known AND matching.
			installReads({ status: null });
			render(CommitGraph, {
				props: { repoPath: "/this/repo", clearRedoStack: vi.fn() },
			});
			await flush();

			const callsBefore = vi
				.mocked(safeInvoke)
				.mock.calls.filter(
					(c) =>
						c[0] === "get_review_session_status" ||
						c[0] === "list_session_commits",
				).length;

			fireSessionChanged("/some/other/repo");
			await flush();

			const callsAfter = vi
				.mocked(safeInvoke)
				.mock.calls.filter(
					(c) =>
						c[0] === "get_review_session_status" ||
						c[0] === "list_session_commits",
				).length;

			// After fix: cross-repo event with null canonicalPath must NOT reload.
			expect(callsAfter).toBe(callsBefore);
		});

		it("filters events by canonical_path once known — own-repo reloads, other-repo does not", async () => {
			installReads({
				status: {
					state: "active",
					file_exists: true,
					canonical_path: "/this/repo",
				},
			});
			render(CommitGraph, {
				props: { repoPath: "/this/repo", clearRedoStack: vi.fn() },
			});
			await flush();

			const callsBefore = vi
				.mocked(safeInvoke)
				.mock.calls.filter((c) => c[0] === "get_review_session_status").length;

			fireSessionChanged("/other/repo");
			await flush();
			expect(
				vi
					.mocked(safeInvoke)
					.mock.calls.filter((c) => c[0] === "get_review_session_status")
					.length,
			).toBe(callsBefore);

			fireSessionChanged("/this/repo");
			await flush();
			expect(
				vi
					.mocked(safeInvoke)
					.mock.calls.filter((c) => c[0] === "get_review_session_status")
					.length,
			).toBeGreaterThan(callsBefore);
		});
	});

	describe("reloadSession error branching (66/WR-02)", () => {
		it("silently empties state on no_session — no toast", async () => {
			installReads({
				override: (cmd) =>
					cmd === "get_review_session_status"
						? Promise.reject({ code: "no_session", message: "no session" })
						: undefined,
			});
			render(CommitGraph, {
				props: { repoPath: "/this/repo", clearRedoStack: vi.fn() },
			});
			await flush();
			expect(vi.mocked(showToast)).not.toHaveBeenCalled();
		});

		it("silently empties state on not_open — no toast", async () => {
			installReads({
				override: (cmd) =>
					cmd === "get_review_session_status"
						? Promise.reject({ code: "not_open", message: "not open" })
						: undefined,
			});
			render(CommitGraph, {
				props: { repoPath: "/this/repo", clearRedoStack: vi.fn() },
			});
			await flush();
			expect(vi.mocked(showToast)).not.toHaveBeenCalled();
		});

		it("surfaces an error toast on unexpected backend failure", async () => {
			installReads({
				override: (cmd) =>
					cmd === "get_review_session_status"
						? Promise.reject({ code: "internal", message: "boom" })
						: undefined,
			});
			render(CommitGraph, {
				props: { repoPath: "/this/repo", clearRedoStack: vi.fn() },
			});
			await flush();
			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				expect.stringMatching(/review/i),
				"error",
			);
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
					clearRedoStack: vi.fn(),
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
					clearRedoStack: vi.fn(),
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
					clearRedoStack: vi.fn(),
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
					clearRedoStack: vi.fn(),
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
					clearRedoStack: vi.fn(),
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

	describe("date column width", () => {
		const COLUMN_PADDING_X = 4;

		function dateColumnWidth(): number {
			const style = screen.getByText("Date").getAttribute("style") ?? "";
			const match = /width:\s*([\d.]+)px/.exec(style);
			if (!match) throw new Error(`no width in date header style: ${style}`);
			return Number(match[1]);
		}

		it("re-fits to the widest producible label when the graph refreshes", async () => {
			const { rerender } = render(CommitGraph, {
				props: {
					repoPath: "/test/repo",
					clearRedoStack: vi.fn(),
					refreshSignal: 0,
				},
			});
			await waitFor(() => {
				expect(screen.getByText("Date")).toBeInTheDocument();
			});
			await flush();

			await rerender({
				repoPath: "/test/repo",
				clearRedoStack: vi.fn(),
				refreshSignal: 1,
			});
			await flush();

			const widestLabel = Math.max(
				...LABEL_VOCABULARY.map((label) => stubTextWidth(label)),
			);
			expect(dateColumnWidth()).toBeGreaterThanOrEqual(
				widestLabel + 2 * COLUMN_PADDING_X,
			);
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
				props: { repoPath: "/test/repo", clearRedoStack: vi.fn() },
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
			clearRedoStack: vi.fn(),
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
				props: { repoPath: "/test/repo", clearRedoStack: vi.fn() },
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
});
