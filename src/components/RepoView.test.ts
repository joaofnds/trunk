import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCommit } from "../__tests__/helpers/factories.js";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSink,
} from "../lib/perf.js";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import type {
	CommitDetail as CommitDetailType,
	FileDiff,
} from "../lib/types.js";
import type { UndoRedoManager } from "../lib/undo-redo.svelte.js";
import RepoView from "./RepoView.svelte";

// Stub OffscreenCanvas for jsdom — used by text-measure.ts (measureTextWidth) via CommitGraph
if (typeof globalThis.OffscreenCanvas === "undefined") {
	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return {
				font: "",
				measureText: () => ({ width: 50 }),
			};
		}
	} as unknown as typeof OffscreenCanvas;
}

// Stub Element.scrollTo for jsdom — VirtualList uses viewport.scrollTo()
if (typeof Element.prototype.scrollTo === "undefined") {
	Element.prototype.scrollTo = () => {};
}

// All Tauri module mocks — declared locally for proper vi.mock hoisting
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		onResized: vi.fn().mockResolvedValue(() => {}),
		onMoved: vi.fn().mockResolvedValue(() => {}),
		isMaximized: vi.fn().mockResolvedValue(false),
		isFullscreen: vi.fn().mockResolvedValue(false),
	}),
}));

// Capture every menu item's { text -> action }: firing the captured callback IS
// the user picking that entry, and it is the only way a Tauri context menu is
// reachable in jsdom.
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
	Submenu: { new: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@tauri-apps/plugin-window-state", () => ({}));

// Mock sortablejs (used by RebaseEditor, which is a child of RepoView)
vi.mock("sortablejs", () => {
	const mockInstance = { destroy: vi.fn(), option: vi.fn() };
	const MockSortable = vi.fn().mockImplementation(() => mockInstance);
	(MockSortable as unknown as Record<string, unknown>).create = vi
		.fn()
		.mockReturnValue(mockInstance);
	return { default: MockSortable };
});

const mockInvoke = vi.mocked(invoke);

function createMockRemoteState(): RemoteState {
	return createRemoteState();
}

function createMockUndoRedo(): UndoRedoManager {
	return {
		state: { redoStack: [] },
		push: vi.fn(),
		pop: vi.fn(),
	};
}

describe("RepoView", () => {
	afterEach(restoreLayout);

	beforeEach(() => {
		// The diff views render through a virtual list, which mounts no rows at
		// all against jsdom's zero-height viewport.
		stubLayout({ width: 900, height: 400 });
		menuActions.clear();
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			switch (cmd) {
				case "get_commit_graph":
					return Promise.resolve({ commits: [], max_columns: 0 });
				case "list_refs":
					return Promise.resolve({
						local: [],
						remote: [],
						tags: [],
						stashes: [],
					});
				case "get_operation_state":
					return Promise.resolve({
						op_type: "None",
						source_branch: null,
						target_branch: null,
						progress: null,
						source_color_index: null,
						target_color_index: null,
						rebase_message: null,
					});
				case "get_push_target":
					return Promise.resolve({ remote: "origin", branch: "main" });
				case "get_status":
					return Promise.resolve({
						unstaged: [],
						staged: [],
						conflicted: [],
					});
				case "get_dirty_counts":
					return Promise.resolve({
						staged: 0,
						unstaged: 0,
						conflicted: 0,
					});
				case "list_stashes":
					return Promise.resolve([]);
				case "get_review_snapshots":
					return Promise.resolve({
						working_tree_snapshot: null,
						index_snapshot: null,
					});
				case "list_session_comments":
				case "list_session_commits":
				case "resolve_session_comments":
					return Promise.resolve([]);
				default:
					return Promise.resolve(undefined);
			}
		});
	});

	it("renders without crashing", () => {
		const { container } = render(RepoView, {
			props: {
				repoPath: "/test/repo",
				repoName: "test-repo",
				remoteState: createMockRemoteState(),
				undoRedo: createMockUndoRedo(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				windowVisible: true,
				tabActive: true,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
			},
		});
		expect(container).toBeTruthy();
		// RepoView renders a <main> element as the top-level orchestrator
		expect(container.querySelector("main")).toBeTruthy();
	});

	it("renders BranchSidebar in left pane", () => {
		const { container } = render(RepoView, {
			props: {
				repoPath: "/test/repo",
				repoName: "test-repo",
				remoteState: createMockRemoteState(),
				undoRedo: createMockUndoRedo(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				windowVisible: true,
				tabActive: true,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
			},
		});
		// BranchSidebar renders as <aside>, verify it exists
		expect(container.querySelector("aside")).toBeTruthy();
	});

	it("calls get_dirty_counts on mount", async () => {
		render(RepoView, {
			props: {
				repoPath: "/test/repo",
				repoName: "test-repo",
				remoteState: createMockRemoteState(),
				undoRedo: createMockUndoRedo(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				windowVisible: true,
				tabActive: true,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
			},
		});
		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("get_dirty_counts", {
				path: "/test/repo",
			});
		});
	});

	it("hides left pane when collapsed", () => {
		const { container } = render(RepoView, {
			props: {
				repoPath: "/test/repo",
				repoName: "test-repo",
				remoteState: createMockRemoteState(),
				undoRedo: createMockUndoRedo(),
				leftPaneWidth: 200,
				leftPaneCollapsed: true,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				windowVisible: true,
				tabActive: true,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
			},
		});
		// When collapsed, the left pane div should have width: 0
		const leftPane = container.querySelector('main > div[style*="width"]');
		expect(leftPane).toBeTruthy();
		expect((leftPane as HTMLElement).style.width).toBe("0px");
	});

	function baseProps(remoteState: RemoteState) {
		return {
			repoPath: "/test/repo",
			repoName: "test-repo",
			remoteState,
			undoRedo: createMockUndoRedo(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: false,
			windowVisible: true,
			tabActive: true,
			reviewActive: false,
			onreviewpanelshowingchange: vi.fn(),
			onleftpanecollapsedchange: vi.fn(),
			onrightpanecollapsedchange: vi.fn(),
			onleftpanewidthchange: vi.fn(),
			onrightpanewidthchange: vi.fn(),
		};
	}

	// The review store has one owner: the rune RepoView creates. The graph and the
	// panel read it rather than fetching a second copy beside it, so the panel has
	// to be on screen for this to mean anything.
	//
	// Counting one read alone cannot say that, because the panel legitimately asks
	// the owner to refresh when it mounts. What a second owner DOES change is the
	// balance between the reads, so they stop moving together. One owner fetches
	// them as a set, always.
	it("fetches the whole store as a set, so nothing owns a second copy", async () => {
		render(RepoView, {
			props: { ...baseProps(createMockRemoteState()), reviewActive: true },
		});
		await new Promise((r) => setTimeout(r, 0));

		const timesCalled = (cmd: string) =>
			mockInvoke.mock.calls.filter((c) => c[0] === cmd).length;
		const refreshes = timesCalled("list_reviews");

		// The absolute count is what distinguishes one owner from two: the five
		// reads leave in one Promise.allSettled, so a second owner doubles them
		// all and every equality below still holds.
		expect(refreshes).toBe(2);
		expect(timesCalled("get_active_review")).toBe(refreshes);
		expect(timesCalled("get_review_snapshots")).toBe(refreshes);
		expect(timesCalled("list_threads")).toBe(refreshes);
		expect(timesCalled("list_session_commits")).toBe(refreshes);
	});

	describe("background fetch", () => {
		// Long enough that the assertion reads "the interval fires", not "the
		// interval is 60s" (DEFAULT_FETCH_INTERVAL_MS, src/lib/store.ts).
		const SEVERAL_INTERVALS_MS = 10 * 60_000;

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("is suppressed while a remote operation is running", async () => {
			const remoteState = createMockRemoteState();
			remoteState.isRunning = true;

			render(RepoView, { props: baseProps(remoteState) });
			await vi.advanceTimersByTimeAsync(SEVERAL_INTERVALS_MS);

			expect(mockInvoke).not.toHaveBeenCalledWith(
				"git_fetch_background",
				expect.anything(),
			);
		});

		it("runs when idle and the window is visible", async () => {
			render(RepoView, { props: baseProps(createMockRemoteState()) });

			await vi.advanceTimersByTimeAsync(SEVERAL_INTERVALS_MS);

			expect(mockInvoke).toHaveBeenCalledWith("git_fetch_background", {
				path: "/test/repo",
			});
		});
	});

	// RepoView hosts a single MessageEditor and threads onopenmessageeditor to its
	// merge/revert trigger children. The editor renders nothing until open() is
	// called ({#if isOpen}), so it is exercised end-to-end in the
	// CommitGraph/BranchSidebar suites where the callback is injected; here we only
	// guard that hosting it does not break the mount.
	it("mounts with the MessageEditor host without crashing", () => {
		const { container } = render(RepoView, {
			props: {
				repoPath: "/test/repo",
				repoName: "test-repo",
				remoteState: createMockRemoteState(),
				undoRedo: createMockUndoRedo(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				windowVisible: true,
				tabActive: true,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
			},
		});
		expect(container.querySelector("main")).toBeTruthy();
		// No message editor dialog is visible before open() is invoked.
		expect(
			container.querySelector('[data-testid="message-editor-backdrop"]'),
		).toBeFalsy();
	});

	describe("out-of-order dirty-count loads", () => {
		const props = () => ({
			repoPath: "/test/repo",
			repoName: "test-repo",
			remoteState: createMockRemoteState(),
			undoRedo: createMockUndoRedo(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: false,
			windowVisible: true,
			tabActive: true,
			reviewActive: false,
			onreviewpanelshowingchange: vi.fn(),
			onleftpanecollapsedchange: vi.fn(),
			onrightpanecollapsedchange: vi.fn(),
			onleftpanewidthchange: vi.fn(),
			onrightpanewidthchange: vi.fn(),
		});

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		it("keeps the newest counts when an older load resolves last", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const pending: ((counts: unknown) => void)[] = [];
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_dirty_counts"
					? new Promise((resolve) => pending.push(resolve))
					: base(cmd, args),
			);
			const { container, rerender } = render(RepoView, { props: props() });
			await flush();
			await rerender(props());
			await flush();
			expect(pending.length).toBeGreaterThanOrEqual(2);

			pending[pending.length - 1]({ staged: 1, unstaged: 0, conflicted: 0 });
			await flush();
			pending[0]({ staged: 0, unstaged: 0, conflicted: 0 });
			await flush();

			expect(container.textContent).toContain("// WIP");
		});
	});

	describe("diff-in-view commit navigation", () => {
		function makeFileDiff(path: string): FileDiff {
			return {
				path,
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			};
		}

		function makeFileDiffWithContent(path: string, content: string): FileDiff {
			return {
				path,
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [
					{
						header: "@@ -1,1 +1,1 @@",
						old_start: 1,
						old_lines: 1,
						new_start: 1,
						new_lines: 1,
						lines: [
							{
								origin: "Add",
								content,
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			};
		}

		function makeDetail(
			oid: string,
			parentOids: string[] = [],
		): CommitDetailType {
			return {
				oid,
				short_oid: oid.slice(0, 7),
				summary: `commit ${oid}`,
				body: null,
				author_name: "Test",
				author_email: "test@test.com",
				author_timestamp: 0,
				committer_name: "Test",
				committer_email: "test@test.com",
				committer_timestamp: 0,
				parent_oids: parentOids,
			};
		}

		let commits: ReturnType<typeof makeCommit>[];
		let filesByOid: Record<string, FileDiff[]>;
		let detailByOid: Record<string, CommitDetailType>;
		// What `diff_commit_file` answers with. Hunkless by default, so a case
		// that cares about the diff's size says so.
		let diffFor: (path: string) => FileDiff;

		beforeEach(() => {
			commits = [];
			filesByOid = {};
			detailByOid = {};
			diffFor = makeFileDiff;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({ commits, max_columns: 1 });
					case "list_commit_files":
						return Promise.resolve(filesByOid[a?.oid as string] ?? []);
					case "get_commit_detail": {
						const detail = detailByOid[a?.oid as string];
						return detail
							? Promise.resolve(detail)
							: Promise.reject("commit not found");
					}
					case "diff_commit_file":
						return Promise.resolve([diffFor(a?.filePath as string)]);
					default:
						return base(cmd, args);
				}
			});
		});

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		async function renderAndGetRows() {
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const rows = await screen.findAllByTestId("commit-row");
			await flush();
			return rows;
		}

		function diffCommitFileCalls() {
			return mockInvoke.mock.calls.filter((c) => c[0] === "diff_commit_file");
		}

		it("reports opening a commit file diff as a named observation", async () => {
			const observed: {
				name: string;
				attrs?: Record<string, string | number>;
			}[] = [];
			const sink: PerfSink = {
				async write(lines) {
					for (const line of lines) observed.push(JSON.parse(line));
				},
			};
			enablePerf({ sink, frames: false });

			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "added");

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			await flushPerf();
			disablePerf();

			const open = observed.find((s) => s.name === "diff.openCommitFile");
			expect(open?.attrs).toEqual({
				path: "f.ts",
				lines: 1,
				fullFile: "false",
			});
		});

		it("reopens the viewed file when the pager moves to a commit touching it", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();

			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			expect(diffCommitFileCalls()).toHaveLength(1);
			expect(diffCommitFileCalls()[0][1]).toMatchObject({
				oid: "oid-2",
				filePath: "f.ts",
			});

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(2);
			expect(diffCommitFileCalls()[1][1]).toMatchObject({
				oid: "oid-1",
				filePath: "f.ts",
			});
		});

		it("opens the first file when the new commit does not touch the viewed path", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("g.ts")],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();

			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(2);
			expect(diffCommitFileCalls()[1][1]).toMatchObject({
				oid: "oid-1",
				filePath: "g.ts",
			});
		});

		it("shows the empty-commit placeholder instead of the graph when hopping to an empty commit", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			// Defer oid-1's file list so the load gap between the pager click and the
			// list landing is observable: the placeholder must stay hidden through it.
			let resolveFiles: ((files: FileDiff[]) => void) | undefined;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "list_commit_files" && a?.oid === "oid-1") {
					return new Promise((resolve) => {
						resolveFiles = resolve;
					});
				}
				return base(cmd, args);
			});

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();
			expect(screen.queryByText(/empty commit/i)).toBeFalsy();

			resolveFiles?.([]);
			await flush();

			expect(await screen.findByText(/empty commit/i)).toBeTruthy();
			expect(screen.queryAllByTestId("commit-row")).toHaveLength(0);
		});

		it("resumes the remembered file after an empty commit", async () => {
			commits = [
				makeCommit({ oid: "oid-3", summary: "third commit" }),
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-3": [makeFileDiff("f.ts")],
				"oid-2": [],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-3": makeDetail("oid-3", ["oid-2"]),
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();
			expect(await screen.findByText(/empty commit/i)).toBeTruthy();

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(2);
			expect(diffCommitFileCalls()[1][1]).toMatchObject({
				oid: "oid-1",
				filePath: "f.ts",
			});
		});

		it("does not auto-open after the diff is closed", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			expect(diffCommitFileCalls()).toHaveLength(1);

			await fireEvent.click(await screen.findByLabelText("Close diff"));
			await flush();

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(1);
		});

		it("ends the mode when the commit detail closes", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			expect(diffCommitFileCalls()).toHaveLength(1);

			await fireEvent.click(
				await screen.findByLabelText("Close commit detail"),
			);
			await flush();

			const newRows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(newRows[1]);
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(1);
		});

		it("does not auto-open when no diff was open", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(0);
		});

		it("re-clicking the selected commit clears the selection", async () => {
			commits = [makeCommit({ oid: "oid-1", summary: "only commit" })];
			filesByOid = { "oid-1": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-1": makeDetail("oid-1") };

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			expect(await screen.findByLabelText("Close commit detail")).toBeTruthy();

			await fireEvent.click(rows[0]);
			await flush();

			expect(screen.queryByLabelText("Close commit detail")).toBeFalsy();
		});

		it("applies only the newest commit's files when responses resolve out of order", async () => {
			commits = [
				makeCommit({ oid: "oid-3", summary: "third commit" }),
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-3": [makeFileDiff("f.ts")],
				"oid-2": [makeFileDiff("x.ts")],
				"oid-1": [makeFileDiff("y.ts")],
			};
			detailByOid = {
				"oid-3": makeDetail("oid-3", ["oid-2"]),
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			let resolveFiles: ((files: FileDiff[]) => void) | undefined;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "list_commit_files" && a?.oid === "oid-2") {
					return new Promise((resolve) => {
						resolveFiles = resolve;
					});
				}
				return base(cmd, args);
			});

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();
			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect((await screen.findAllByText("y.ts")).length).toBeGreaterThan(0);

			resolveFiles?.(filesByOid["oid-2"]);
			await flush();

			expect(screen.queryAllByText("x.ts")).toHaveLength(0);
			expect(screen.queryAllByText("y.ts").length).toBeGreaterThan(0);
			expect(
				diffCommitFileCalls().some(
					(c) => (c[1] as Record<string, unknown>).oid === "oid-2",
				),
			).toBe(false);
		});

		it("ignores a stale per-file diff from the previous commit", async () => {
			commits = [
				makeCommit({ oid: "oid-3", summary: "third commit" }),
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-3": [makeFileDiff("f.ts")],
				"oid-2": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-3": makeDetail("oid-3", ["oid-2"]),
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			let resolveB: ((files: FileDiff[]) => void) | undefined;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "diff_commit_file" && a?.oid === "oid-2") {
					return new Promise((resolve) => {
						resolveB = resolve;
					});
				}
				if (cmd === "diff_commit_file" && a?.oid === "oid-1") {
					return Promise.resolve([
						makeFileDiffWithContent("f.ts", "C-CONTENT"),
					]);
				}
				return base(cmd, args);
			});

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();
			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			expect(await screen.findByText("C-CONTENT")).toBeTruthy();

			resolveB?.([makeFileDiffWithContent("f.ts", "B-CONTENT")]);
			await flush();

			expect(screen.queryByText("B-CONTENT")).toBeFalsy();
			expect(screen.getByText("C-CONTENT")).toBeTruthy();
		});

		it("ends the mode when the commit switch fails", async () => {
			commits = [
				makeCommit({ oid: "oid-3", summary: "third commit" }),
				makeCommit({ oid: "oid-2", summary: "second commit (fails)" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = {
				"oid-3": [makeFileDiff("f.ts")],
				"oid-1": [makeFileDiff("f.ts")],
			};
			detailByOid = {
				"oid-3": makeDetail("oid-3", ["oid-2"]),
				"oid-2": makeDetail("oid-2", ["oid-1"]),
				"oid-1": makeDetail("oid-1"),
			};

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			expect(diffCommitFileCalls()).toHaveLength(1);

			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "list_commit_files" && a?.oid === "oid-2") {
					return Promise.reject("boom");
				}
				return base(cmd, args);
			});

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await flush();

			// Mode ended: the center pane drops back to the graph.
			const graphRows = await screen.findAllByTestId("commit-row");
			expect(graphRows.length).toBeGreaterThan(0);

			await fireEvent.click(graphRows[2]);
			await flush();

			expect(diffCommitFileCalls()).toHaveLength(1);
		});
	});
	describe("interactive rebase from a commit's context menu", () => {
		const HEAD_OID = "aaa1111aaa1111aaa1111aaa1111aaa1111aaa11";
		const CLICKED_OID = "bbb2222bbb2222bbb2222bbb2222bbb2222bbb22";
		const PARENT_OID = "ccc3333ccc3333ccc3333ccc3333ccc3333ccc33";

		function todoItem(oid: string, summary: string) {
			return {
				oid,
				short_oid: oid.slice(0, 7),
				summary,
				author_name: "Test",
				author_timestamp: 0,
			};
		}

		function stubRebaseTodo(
			baseOid: string | null,
			startResult: { kind: string } = { kind: "completed" },
		) {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({
							commits: [
								makeCommit({
									oid: HEAD_OID,
									summary: "head commit",
									is_head: true,
									refs: [
										{
											name: "refs/heads/main",
											short_name: "main",
											ref_type: "LocalBranch",
											is_head: true,
											color_index: 0,
										},
									],
								}),
								makeCommit({
									oid: CLICKED_OID,
									summary: "clicked commit",
									in_head_chain: true,
								}),
							],
							max_columns: 1,
						});
					case "start_interactive_rebase":
						return Promise.resolve(startResult);
					case "get_rebase_todo":
						return Promise.resolve({
							base_oid: baseOid,
							items: [
								todoItem(CLICKED_OID, "clicked commit"),
								todoItem(HEAD_OID, "head commit"),
							],
						});
					default:
						return base(cmd, args);
				}
			});
		}

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		beforeEach(_resetToasts);

		async function openTheEditorOnTheClickedCommit() {
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.contextMenu(rows[1]);
			await flush();
			await getMenuAction("Interactive Rebase...")();
			await flush();
		}

		it("raises a toast when the rebase stops", async () => {
			stubRebaseTodo(PARENT_OID, { kind: "stopped" });

			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(await screen.findByText("Start Rebase"));
			await flush();

			expect(toasts.items).toContainEqual(
				expect.objectContaining({
					message: "Rebase stopped — resolve it in the staging panel",
					kind: "error",
				}),
			);
		});

		it("labels a root-based rebase as onto root", async () => {
			stubRebaseTodo(null);

			await openTheEditorOnTheClickedCommit();

			expect(await screen.findByText("root")).toBeTruthy();
		});

		it("starts the rebase at the base the backend resolved, not the clicked commit", async () => {
			stubRebaseTodo(PARENT_OID);

			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(await screen.findByText("Start Rebase"));
			await flush();

			expect(mockInvoke).toHaveBeenCalledWith("start_interactive_rebase", {
				path: "/test/repo",
				baseOid: PARENT_OID,
				todoItems: [
					{
						oid: CLICKED_OID,
						action: "pick",
						summary: "clicked commit",
						newMessage: null,
					},
					{
						oid: HEAD_OID,
						action: "pick",
						summary: "head commit",
						newMessage: null,
					},
				],
			});
		});
	});

	describe("compare selection (TRUNK-1)", () => {
		function makeFileDiff(path: string): FileDiff {
			return {
				path,
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			};
		}

		function makeDetail(
			oid: string,
			parentOids: string[] = [],
		): CommitDetailType {
			return {
				oid,
				short_oid: oid.slice(0, 7),
				summary: `commit ${oid}`,
				body: null,
				author_name: "Test",
				author_email: "test@test.com",
				author_timestamp: 0,
				committer_name: "Test",
				committer_email: "test@test.com",
				committer_timestamp: 0,
				parent_oids: parentOids,
			};
		}

		let commits: ReturnType<typeof makeCommit>[];

		beforeEach(() => {
			// oid-3 → oid-2 → oid-1, newest first, mirroring the graph order.
			commits = [
				makeCommit({
					oid: "oid-3",
					summary: "third commit",
					parent_oids: ["oid-2"],
				}),
				makeCommit({
					oid: "oid-2",
					summary: "second commit",
					parent_oids: ["oid-1"],
				}),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({ commits, max_columns: 1 });
					case "list_commit_files":
						return Promise.resolve([]);
					case "get_commit_detail":
						return Promise.resolve(
							makeDetail(
								a?.oid as string,
								commits.find((c) => c.oid === a?.oid)?.parent_oids ?? [],
							),
						);
					case "list_compare_files":
						return Promise.resolve([makeFileDiff("f.ts")]);
					case "compare_stat":
						return Promise.resolve({
							insertions: 5,
							deletions: 2,
							files_changed: 1,
						});
					case "diff_compare_file":
						return Promise.resolve([makeFileDiff(a?.filePath as string)]);
					default:
						return base(cmd, args);
				}
			});
		});

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		async function renderAndGetRows() {
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const rows = await screen.findAllByTestId("commit-row");
			await flush();
			return rows;
		}

		function compareCalls() {
			return mockInvoke.mock.calls.filter((c) => c[0] === "list_compare_files");
		}

		it("cmd-clicking a second commit opens the compare, first pick as Base", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]); // oid-1
			await flush();
			await fireEvent.click(rows[0], { metaKey: true }); // oid-3
			await flush();

			expect(compareCalls()).toHaveLength(1);
			expect(compareCalls()[0][1]).toMatchObject({
				baseOid: "oid-1",
				targetOid: "oid-3",
			});
			const header = await screen.findByTestId("compare-header");
			expect(header.textContent).toContain("oid-1");
			expect(header.textContent).toContain("oid-3");
		});

		it("shift-clicking compares parent(oldest) to newest", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]); // oid-3
			await flush();
			await fireEvent.click(rows[1], { shiftKey: true }); // oid-2, older
			await flush();

			expect(compareCalls()).toHaveLength(1);
			expect(compareCalls()[0][1]).toMatchObject({
				baseOid: "oid-1",
				targetOid: "oid-3",
			});
		});

		it("swap flips Base and Target and reloads", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();

			await fireEvent.click(
				await screen.findByLabelText("Swap comparison direction"),
			);
			await flush();

			expect(compareCalls()).toHaveLength(2);
			expect(compareCalls()[1][1]).toMatchObject({
				baseOid: "oid-3",
				targetOid: "oid-1",
			});
		});

		it("clicking a compare file opens its Base-to-Target diff", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();

			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			const calls = mockInvoke.mock.calls.filter(
				(c) => c[0] === "diff_compare_file",
			);
			expect(calls).toHaveLength(1);
			expect(calls[0][1]).toMatchObject({
				baseOid: "oid-1",
				targetOid: "oid-3",
				filePath: "f.ts",
			});
		});

		it("escape clears the compare", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			expect(screen.queryByTestId("compare-header")).toBeTruthy();

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(screen.queryByTestId("compare-header")).toBeNull();
		});

		it("a plain click on a third commit dissolves the compare", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]); // oid-1
			await flush();
			await fireEvent.click(rows[0], { metaKey: true }); // oid-3
			await flush();
			expect(screen.queryByTestId("compare-header")).toBeTruthy();

			await fireEvent.click(rows[1]); // oid-2, no modifier
			await flush();

			expect(screen.queryByTestId("compare-header")).toBeNull();
		});

		it("clicking the WIP row dissolves the compare", async () => {
			const withCompare = mockInvoke.getMockImplementation();
			if (!withCompare)
				throw new Error("compare invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_dirty_counts"
					? Promise.resolve({ staged: 1, unstaged: 0, conflicted: 0 })
					: withCompare(cmd, args),
			);
			const rows = await renderAndGetRows();
			// rows[0] is the WIP row; commits shift down one.
			await fireEvent.click(rows[3]); // oid-1
			await flush();
			await fireEvent.click(rows[1], { metaKey: true }); // oid-3
			await flush();
			expect(screen.queryByTestId("compare-header")).toBeTruthy();

			await fireEvent.click(rows[0]);
			await flush();

			expect(screen.queryByTestId("compare-header")).toBeNull();
		});

		it("a review jump to a commit dissolves the compare", async () => {
			const withCompare = mockInvoke.getMockImplementation();
			if (!withCompare)
				throw new Error("compare invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "list_session_commits"
					? Promise.resolve([
							{
								oid: "oid-2",
								short_oid: "oid-2",
								summary: "second commit",
								is_snapshot: false,
							},
						])
					: withCompare(cmd, args),
			);
			const props = baseProps(createMockRemoteState());
			const { rerender } = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await flush();
			await fireEvent.click(rows[2]); // oid-1
			await flush();
			await fireEvent.click(rows[0], { metaKey: true }); // oid-3
			await flush();
			expect(screen.queryByTestId("compare-header")).toBeTruthy();

			await rerender({ ...props, reviewActive: true });
			await flush();
			await fireEvent.click(
				await screen.findByLabelText("Jump to commit oid-2"),
			);
			await flush();

			expect(screen.queryByTestId("compare-header")).toBeNull();
		});

		it("a compare diff offers no comment affordance", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();

			expect(screen.queryByText("Comment File")).toBeNull();
		});

		it("escape in an inactive tab leaves the compare diff alone", async () => {
			render(RepoView, {
				props: { ...baseProps(createMockRemoteState()), tabActive: false },
			});
			const rows = await screen.findAllByTestId("commit-row");
			await flush();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			// The file diff replaces the graph in the center pane.
			expect(screen.queryAllByTestId("commit-row")).toHaveLength(0);

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(screen.queryAllByTestId("commit-row")).toHaveLength(0);
			expect(screen.queryByTestId("compare-header")).toBeTruthy();
		});

		it("the comment badge empties while a compare is open", async () => {
			const withCompare = mockInvoke.getMockImplementation();
			if (!withCompare)
				throw new Error("compare invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "list_threads"
					? Promise.resolve([
							aThread({
								id: "t1",
								review_id: "r1",
								text: "a note",
								commit_oid: "oid-1",
							}),
						])
					: withCompare(cmd, args),
			);
			const counts = vi.fn();
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					oncommentcountschange: counts,
				},
			});
			const rows = await screen.findAllByTestId("commit-row");
			await flush();
			await fireEvent.click(rows[2]); // oid-1 — its commit-level note counts
			await flush();
			expect(counts.mock.calls.at(-1)?.[0].view).toBe(1);

			await fireEvent.click(rows[0], { metaKey: true });
			await flush();

			expect(counts.mock.calls.at(-1)?.[0].view).toBe(0);
		});
	});
});
