import { invoke } from "@tauri-apps/api/core";
import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
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

vi.mock("@tauri-apps/api/menu", () => ({
	Menu: {
		new: vi.fn().mockResolvedValue({
			popup: vi.fn().mockResolvedValue(undefined),
		}),
	},
	MenuItem: { new: vi.fn().mockResolvedValue({}) },
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
		clear: vi.fn(),
	};
}

describe("RepoView", () => {
	beforeEach(() => {
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
});
