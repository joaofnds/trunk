import { invoke } from "@tauri-apps/api/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import RepoView from "../__tests__/helpers/controlled-repo-view.svelte";
import { makeCommit } from "../__tests__/helpers/factories.js";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import { aReview } from "../__tests__/helpers/review-fixture.js";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { REPO_CHANGE_DELAY_MS } from "../lib/coalesced-task.js";
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
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import type {
	CommitDetail as CommitDetailType,
	ContentMode,
	DiffRequestOptions,
	FileDiff,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import type { UndoRedoManager } from "../lib/undo-redo.svelte.js";

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

// jsdom lays nothing out, so it has no scrollIntoView for the review panel to
// call when it brings back the thread a jump to code left from.
if (typeof Element.prototype.scrollIntoView === "undefined") {
	Element.prototype.scrollIntoView = () => {};
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

// Captured so a test can drive the watcher's `repo-changed` path; the suite
// otherwise never fires one.
const eventHandlers = new Map<
	string,
	Array<(event: { payload: unknown }) => void>
>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(
		(name: string, handler: (event: { payload: unknown }) => void) => {
			const registered = eventHandlers.get(name) ?? [];
			registered.push(handler);
			eventHandlers.set(name, registered);
			return Promise.resolve(() => {});
		},
	),
}));

/** The graph stays mounted, unseen, under a pane that covers it. */
function graphIsCovered(): boolean {
	const rows = screen.queryAllByTestId("commit-row");
	return (
		rows.length > 0 && rows.every((row) => row.closest(".invisible") !== null)
	);
}

function graphIsShown(): boolean {
	const rows = screen.queryAllByTestId("commit-row");
	return (
		rows.length > 0 && rows.every((row) => row.closest(".invisible") === null)
	);
}

function fireRepoChanged(
	repo: string,
	paths: string[],
	extra: { refs_only?: boolean; graph_revision?: number } = {},
): void {
	const registered = eventHandlers.get("repo-changed") ?? [];
	if (registered.length === 0) throw new Error("no repo-changed listener");
	for (const handler of registered)
		handler({ payload: { repo, paths, ...extra } });
}

function fireReviewShowPanel(): void {
	const registered = eventHandlers.get("review-show-panel") ?? [];
	if (registered.length === 0) throw new Error("no review-show-panel listener");
	for (const handler of registered) handler({ payload: undefined });
}

function fireReviewsChanged(canonicalPath: string): void {
	const registered = eventHandlers.get("reviews-changed") ?? [];
	if (registered.length === 0) throw new Error("no reviews-changed listener");
	for (const handler of registered) handler({ payload: canonicalPath });
}

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

function holdLazyModule(path: string, label: string) {
	const request = Promise.withResolvers<{ default: typeof Button }>();
	const entered = Promise.withResolvers<void>();
	vi.doMock(path, () => {
		entered.resolve();
		return request.promise;
	});
	onTestFinished(async () => {
		cleanup();
		request.resolve({ default: Button });
		await vi.dynamicImportSettled();
		vi.doUnmock(path);
		// Finish the queued unmock before the next test starts concurrent imports.
		await vi.importActual(path);
	});
	const pending = async () => {
		await screen.findByText(`Opening ${label}…`);
		await entered.promise;
	};
	return {
		pending,
		failed: async () => {
			await pending();
			request.reject(new Error(`${label} unavailable`));
			await screen.findByText(`Could not load ${label}.`);
		},
		expectCancelled: () => {
			expect(screen.queryByText(`Opening ${label}…`)).toBeNull();
			expect(screen.queryByText(`Could not load ${label}.`)).toBeNull();
		},
	};
}

describe("RepoView", () => {
	afterEach(restoreLayout);

	beforeEach(() => {
		// The diff views render through a virtual list, which mounts no rows at
		// all against jsdom's zero-height viewport.
		stubLayout({ width: 900, height: 400 });
		eventHandlers.clear();
		menuActions.clear();
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			switch (cmd) {
				case "get_commit_graph":
					return Promise.resolve({ commits: [], max_columns: 0, revision: 1 });
				case "get_commit_stats":
					return Promise.resolve({});
				case "get_commit_detail":
					return Promise.reject("commit not found");
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
						onto_oid: null,
						progress: null,
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
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
				onleavereview: vi.fn(),
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
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
				onleavereview: vi.fn(),
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
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
				onleavereview: vi.fn(),
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
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
				onleavereview: vi.fn(),
			},
		});
		// When collapsed, the left pane div should have width: 0
		const leftPane = container.querySelector(
			'main > div > div[style*="width"]',
		);
		expect(leftPane).toBeTruthy();
		expect((leftPane as HTMLElement).style.width).toBe("0px");
	});

	function renderWithPanes(panes: {
		leftPaneWidth?: number;
		rightPaneWidth?: number;
		leftPaneCollapsed?: boolean;
		rightPaneCollapsed?: boolean;
		reviewActive?: boolean;
	}) {
		const changes: string[] = [];
		const view = render(RepoView, {
			props: {
				...baseProps(createMockRemoteState()),
				...panes,
				onleftpanewidthchange: (width) => {
					changes.push(`left width ${width}`);
					void view.rerender({ leftPaneWidth: width });
				},
				onrightpanewidthchange: (width) => {
					changes.push(`right width ${width}`);
					void view.rerender({ rightPaneWidth: width });
				},
				onleftpanecollapsedchange: (collapsed) => {
					changes.push(`left collapsed ${collapsed}`);
					void view.rerender({ leftPaneCollapsed: collapsed });
				},
				onrightpanecollapsedchange: (collapsed) => {
					changes.push(`right collapsed ${collapsed}`);
					void view.rerender({ rightPaneCollapsed: collapsed });
				},
			},
		});

		return changes;
	}

	async function drag(handle: HTMLElement, from: number, to: number) {
		await fireEvent.mouseDown(handle, { clientX: from });
		await fireEvent.mouseMove(window, { clientX: to });
		await fireEvent.mouseUp(window);
	}

	it("widens the sidebar by a step when its divider takes ArrowRight", async () => {
		const changes = renderWithPanes({ leftPaneWidth: 200 });

		await fireEvent.keyDown(
			screen.getByRole("slider", { name: "Resize sidebar" }),
			{ key: "ArrowRight" },
		);

		expect(changes).toEqual(["left collapsed false", "left width 208"]);
	});

	it("narrows the detail pane by a step when its divider takes ArrowRight", async () => {
		const changes = renderWithPanes({ rightPaneWidth: 300 });

		await fireEvent.keyDown(
			screen.getByRole("slider", { name: "Resize detail pane" }),
			{ key: "ArrowRight" },
		);

		expect(changes).toEqual(["right collapsed false", "right width 292"]);
	});

	it.each([
		{ pane: "sidebar", key: "ArrowRight", widest: "left width 600" },
		{ pane: "detail pane", key: "ArrowLeft", widest: "right width 700" },
	])(
		"stops the $pane at the width a drag stops it at",
		async ({ pane, key, widest }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 596,
				rightPaneWidth: 696,
			});

			await fireEvent.keyDown(
				screen.getByRole("slider", { name: `Resize ${pane}` }),
				{ key },
			);

			expect(changes).toContain(widest);
		},
	);

	it.each([
		{ pane: "sidebar", key: "ArrowLeft", collapsed: "left collapsed true" },
		{
			pane: "detail pane",
			key: "ArrowRight",
			collapsed: "right collapsed true",
		},
	])(
		"collapses the $pane when a step takes it under the width a drag collapses it at",
		async ({ pane, key, collapsed }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 56,
				rightPaneWidth: 56,
			});

			await fireEvent.keyDown(
				screen.getByRole("slider", { name: `Resize ${pane}` }),
				{ key },
			);

			expect(changes).toEqual([collapsed]);
		},
	);

	it("reopens a collapsed detail pane at the narrowest width a drag leaves it open at", async () => {
		const changes = renderWithPanes({
			rightPaneWidth: 300,
			rightPaneCollapsed: true,
		});

		await fireEvent.keyDown(screen.getByLabelText("Resize detail pane"), {
			key: "ArrowLeft",
		});

		expect(changes).toEqual(["right collapsed false", "right width 50"]);
	});

	it("leaves a collapsed detail pane collapsed when a step would narrow it", async () => {
		const changes = renderWithPanes({
			rightPaneWidth: 300,
			rightPaneCollapsed: true,
		});

		await fireEvent.keyDown(screen.getByLabelText("Resize detail pane"), {
			key: "ArrowRight",
		});

		expect(changes).toEqual([]);
	});

	it.each([
		{ pane: "sidebar", to: 1500, widest: "left width 600" },
		{ pane: "detail pane", to: 500, widest: "right width 700" },
	])(
		"stops a drag of the $pane at its widest",
		async ({ pane, to, widest }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 200,
				rightPaneWidth: 300,
			});

			await drag(
				screen.getByRole("slider", { name: `Resize ${pane}` }),
				1000,
				to,
			);

			expect(changes).toContain(widest);
		},
	);

	it.each([
		{
			pane: "sidebar",
			to: 849,
			collapsed: ["left collapsed true", "left width 200"],
		},
		{
			pane: "detail pane",
			to: 1251,
			collapsed: ["right collapsed true", "right width 300"],
		},
	])(
		"collapses the $pane when a drag leaves it narrower than 50 pixels",
		async ({ pane, to, collapsed }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 200,
				rightPaneWidth: 300,
			});

			await drag(
				screen.getByRole("slider", { name: `Resize ${pane}` }),
				1000,
				to,
			);

			expect(changes).toEqual(collapsed);
		},
	);

	it.each([
		{ pane: "sidebar", through: [852, 800], kept: "left width 200" },
		{ pane: "detail pane", through: [1248, 1300], kept: "right width 300" },
	])(
		"keeps the width the $pane had when a drag closes it, to reopen at",
		async ({ pane, through, kept }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 200,
				rightPaneWidth: 300,
			});
			const handle = screen.getByRole("slider", { name: `Resize ${pane}` });

			await fireEvent.mouseDown(handle, { clientX: 1000 });
			for (const clientX of through)
				await fireEvent.mouseMove(window, { clientX });
			await fireEvent.mouseUp(window);

			expect(changes.at(-1)).toBe(kept);
		},
	);

	it.each([
		{ pane: "sidebar", key: "ArrowLeft", kept: "left width 64" },
		{ pane: "detail pane", key: "ArrowRight", kept: "right width 64" },
	])(
		"keeps the width the $pane had when steps close it, to reopen at",
		async ({ pane, key, kept }) => {
			const changes = renderWithPanes({
				leftPaneWidth: 64,
				rightPaneWidth: 64,
			});
			const handle = screen.getByRole("slider", { name: `Resize ${pane}` });

			await fireEvent.keyDown(handle, { key });
			await fireEvent.keyDown(handle, { key });

			expect(changes.at(-1)).toBe(kept);
		},
	);

	// Only the divider beside the rebase editor shows while its pane is
	// collapsed, and both dividers run this same drag.
	it("reopens the detail pane at its width after a drag opens it and closes it again", async () => {
		const changes = renderWithPanes({
			rightPaneWidth: 300,
			rightPaneCollapsed: true,
		});
		const handle = screen.getByLabelText("Resize detail pane");

		await fireEvent.mouseDown(handle, { clientX: 1000 });
		await fireEvent.mouseMove(window, { clientX: 900 });
		await fireEvent.mouseMove(window, { clientX: 1000 });
		await fireEvent.mouseUp(window);

		expect(changes.at(-1)).toBe("right width 300");
	});

	it("lets go of the focus in the detail pane when it collapses", async () => {
		renderWithPanes({ rightPaneWidth: 56 });
		const [field] = await screen.findAllByPlaceholderText(
			"Description (optional)",
		);
		field.focus();

		await fireEvent.keyDown(
			screen.getByRole("slider", { name: "Resize detail pane" }),
			{ key: "ArrowRight" },
		);

		expect(document.activeElement).not.toBe(field);
	});

	it("lets go of the focus in the sidebar when it collapses", async () => {
		renderWithPanes({ leftPaneWidth: 56 });
		const filter = await screen.findByPlaceholderText("Filter branches…");
		filter.focus();

		await fireEvent.keyDown(
			screen.getByRole("slider", { name: "Resize sidebar" }),
			{ key: "ArrowLeft" },
		);

		expect(document.activeElement).not.toBe(filter);
	});

	it("reopens a collapsed detail pane when a drag takes it to 50 pixels", async () => {
		const changes = renderWithPanes({
			rightPaneWidth: 300,
			rightPaneCollapsed: true,
		});

		await drag(screen.getByLabelText("Resize detail pane"), 1000, 950);

		expect(changes).toEqual(["right collapsed false", "right width 50"]);
	});

	it("stores the width a drag left the sidebar at when it is released", async () => {
		renderWithPanes({ leftPaneWidth: 200 });

		await drag(
			screen.getByRole("slider", { name: "Resize sidebar" }),
			1000,
			1040,
		);

		expect(mockInvoke).toHaveBeenCalledWith("prefs_set", {
			key: "left_pane_width",
			value: 240,
		});
	});

	it("tells assistive tech each pane's width and the widths it moves between", () => {
		renderWithPanes({ leftPaneWidth: 200, rightPaneWidth: 300 });

		const sidebar = screen.getByRole("slider", { name: "Resize sidebar" });
		const detail = screen.getByRole("slider", { name: "Resize detail pane" });

		expect(sidebar).toHaveAttribute("aria-valuenow", "200");
		expect(sidebar).toHaveAttribute("aria-valuemax", "600");
		expect(detail).toHaveAttribute("aria-valuenow", "300");
		expect(detail).toHaveAttribute("aria-valuemax", "700");
	});

	it("takes the divider of a collapsed sidebar out of the Tab order", () => {
		renderWithPanes({ leftPaneCollapsed: true });

		expect(screen.queryByRole("slider", { name: "Resize sidebar" })).toBeNull();
	});

	// Review mode is a window of its own: the reviews take the sidebar's place
	// and its width, and nothing stands beside the review on the right.
	describe("in review mode", () => {
		// What a review's counts read once the list read sees its one open thread.
		const oneOpenThread = {
			state: "open",
			thread_count: 1,
			unresolved_count: 1,
		} as const;

		async function flush() {
			await vi.dynamicImportSettled();
			await tick();
		}

		it("puts the reviews where the branches and stashes were", async () => {
			renderWithPanes({ reviewActive: true });

			expect(
				await screen.findByRole("navigation", { name: "Reviews" }),
			).toBeVisible();
			expect(screen.getByTestId("branch-sidebar")).not.toBeVisible();
		});

		it("resizes the reviews with the sidebar's divider", async () => {
			const changes = renderWithPanes({
				leftPaneWidth: 200,
				reviewActive: true,
			});

			await drag(
				screen.getByRole("slider", { name: "Resize sidebar" }),
				1000,
				1040,
			);

			expect(changes).toEqual(["left collapsed false", "left width 240"]);
		});

		it("takes the reviews away while the sidebar is collapsed", async () => {
			renderWithPanes({ leftPaneCollapsed: true, reviewActive: true });
			await flush();

			expect(screen.queryByRole("navigation", { name: "Reviews" })).toBeNull();
		});

		it("shows no detail pane", async () => {
			renderWithPanes({ rightPaneWidth: 300, reviewActive: true });
			await flush();

			expect(
				screen.queryByRole("slider", { name: "Resize detail pane" }),
			).toBeNull();
		});

		// The graph is not on screen in review mode, so a commit is shown by
		// leaving it.
		it("leaves review mode for the graph to show a commit's header jump", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const commit = makeCommit({ oid: "oid-1", summary: "the commit" });
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({
							commits: [commit],
							max_columns: 1,
							revision: 1,
						});
					case "list_reviews":
						return Promise.resolve([aReview({ id: "r1", title: "r1" })]);
					case "get_active_review":
						return Promise.resolve("r1");
					case "list_session_commits":
						return Promise.resolve([
							aSessionCommit({ oid: commit.oid, summary: "the commit" }),
						]);
					default:
						return base(cmd, args);
				}
			});
			const leaves = vi.fn();
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					reviewActive: true,
					onleavereview: leaves,
				},
			});

			await fireEvent.click(
				await screen.findByRole("button", {
					name: `Jump to commit ${commit.oid.slice(0, 7)}`,
				}),
			);

			expect(leaves).toHaveBeenCalledOnce();
		});

		// One review with one thread on line 1 of a commit's file, so pressing
		// "Line 1" jumps to code.
		function reviewWithOneLineThread() {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const commit = makeCommit({ oid: "oid-1", summary: "the commit" });
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({
							commits: [commit],
							max_columns: 1,
							revision: 1,
						});
					case "list_reviews":
						return Promise.resolve([
							aReview({
								id: "r1",
								title: "r1",
								thread_count: 1,
								unresolved_count: 1,
							}),
						]);
					case "get_active_review":
						return Promise.resolve("r1");
					case "list_session_commits":
						return Promise.resolve([aSessionCommit({ oid: commit.oid })]);
					case "list_threads":
						return Promise.resolve([
							aThread({
								id: "t1",
								review_id: "r1",
								anchor: {
									commit_oid: commit.oid,
									file_path: "src/a.ts",
									source: "Diff",
									side: "New",
									start_line: 1,
									end_line: 1,
								},
							}),
						]);
					case "resolve_threads":
					case "list_commit_files":
						return Promise.resolve([]);
					default:
						return base(cmd, args);
				}
			});
		}

		it("keeps a collapsed detail pane collapsed through a jump to code", async () => {
			reviewWithOneLineThread();
			const changes = renderWithPanes({
				rightPaneCollapsed: true,
				reviewActive: true,
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Line 1" }),
			);
			await flush();

			expect(changes).not.toContain("right collapsed false");
		});

		it("puts focus back on the thread a jump to code left from", async () => {
			reviewWithOneLineThread();
			renderWithPanes({ reviewActive: true });
			await fireEvent.click(
				await screen.findByRole("button", { name: "Line 1" }),
			);
			await flush();

			await fireEvent.click(
				await screen.findByRole("button", { name: "Close diff" }),
			);
			await flush();

			const threads = screen.getByRole("region", { name: "Review threads" });
			expect(within(threads).getByRole("article")).toHaveFocus();
		});

		it("keeps a reply typed on a review that is not active while another review is shown", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "list_reviews":
						return Promise.resolve([
							aReview({ id: "r1", title: "Active one", ...oneOpenThread }),
							aReview({ id: "r2", title: "Shown one", ...oneOpenThread }),
						]);
					case "get_active_review":
						return Promise.resolve("r1");
					case "list_threads": {
						const reviewId =
							(args as { reviewId?: string } | undefined)?.reviewId ?? "r1";
						return Promise.resolve([
							aThread({ id: `t-${reviewId}`, review_id: reviewId }),
						]);
					}
					case "resolve_threads":
						return Promise.resolve([]);
					default:
						return base(cmd, args);
				}
			});
			renderWithPanes({ reviewActive: true });
			await fireEvent.click(await screen.findByText("Shown one"));
			await flush();
			const reply = (await screen.findByLabelText(
				"Reply",
			)) as HTMLTextAreaElement;
			await fireEvent.input(reply, { target: { value: "half a reply" } });
			await fireEvent.click(screen.getByText("Active one"));
			await flush();

			await fireEvent.click(screen.getByText("Shown one"));
			await flush();

			expect(await screen.findByLabelText("Reply")).toHaveValue("half a reply");
		});

		// Two reviews, each with a thread on new line 1 of the same file of one
		// commit: r1, "Active one", is active, and r2, "Shown one", is not.
		const NOTE_OF: Record<string, string> = {
			r1: "a note on the active review",
			r2: "a note on the review shown",
		};

		function twoReviewsOnOneLine(props: { secondArchived: boolean }) {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const commit = makeCommit({ oid: "oid-1", summary: "the commit" });
			const detail: CommitDetailType = {
				oid: commit.oid,
				short_oid: commit.short_oid,
				summary: commit.summary,
				body: null,
				author_name: "Test",
				author_email: "test@test.com",
				author_timestamp: 0,
				committer_name: "Test",
				committer_email: "test@test.com",
				committer_timestamp: 0,
				parent_oids: [],
			};
			const file: FileDiff = {
				path: "src/a.ts",
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
								content: "export const a = 1;",
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			};
			const threadOf = (reviewId: string) =>
				aThread({
					id: `t-${reviewId}`,
					review_id: reviewId,
					text: NOTE_OF[reviewId],
					anchor: {
						commit_oid: commit.oid,
						file_path: file.path,
						source: "Diff",
						side: "New",
						start_line: 1,
						end_line: 1,
					},
				});
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				switch (cmd) {
					case "get_commit_graph":
						return Promise.resolve({
							commits: [commit],
							max_columns: 1,
							revision: 1,
						});
					case "list_reviews":
						return Promise.resolve([
							aReview({ id: "r1", title: "Active one", ...oneOpenThread }),
							aReview({
								id: "r2",
								title: "Shown one",
								archived: props.secondArchived,
								...oneOpenThread,
							}),
						]);
					case "canonical_repo_path":
						return Promise.resolve("/test/repo");
					case "get_active_review":
						return Promise.resolve("r1");
					case "list_session_commits":
						return Promise.resolve([aSessionCommit({ oid: commit.oid })]);
					case "list_threads":
						return Promise.resolve([
							threadOf((a?.reviewId as string | undefined) ?? "r1"),
						]);
					case "resolve_threads":
						return Promise.resolve([]);
					case "get_commit_detail":
						return Promise.resolve(detail);
					case "list_commit_files":
						return Promise.resolve([file]);
					case "diff_commit_file":
						return Promise.resolve([file]);
					default:
						return base(cmd, args);
				}
			});
		}

		// Enter opens the focused thread's code, and J focuses the only thread.
		async function openThreadWithEnter() {
			await screen.findByRole("button", { name: "Line 1" });
			await fireEvent.keyDown(window, { key: "j" });
			await flush();
			await fireEvent.keyDown(window, { key: "Enter" });
			await flush();
		}

		// The panel's own card is hidden while a diff is open, so once the diff
		// is up the only card on screen is one the diff draws.
		async function cardInTheDiff() {
			await screen.findByRole("button", { name: "Close diff" });
			return screen.getByRole("article");
		}

		async function showReview(title: string) {
			await fireEvent.click(await screen.findByText(title));
			await flush();
		}

		it("draws the thread of a live review that is shown and not active in the diff Enter opens", async () => {
			twoReviewsOnOneLine({ secondArchived: false });
			renderWithPanes({ reviewActive: true });
			await showReview("Shown one");

			await openThreadWithEnter();

			expect(await cardInTheDiff()).toHaveTextContent(NOTE_OF.r2);
		});

		it("draws the thread of an archived review that is shown in the diff Enter opens", async () => {
			twoReviewsOnOneLine({ secondArchived: true });
			renderWithPanes({ reviewActive: true });
			await fireEvent.click(
				await screen.findByRole("button", { name: "Archived 1" }),
			);
			await showReview("Shown one");

			await openThreadWithEnter();

			expect(await cardInTheDiff()).toHaveTextContent(NOTE_OF.r2);
		});

		it("draws the active review's threads in the diff Enter opens while it is shown", async () => {
			twoReviewsOnOneLine({ secondArchived: false });
			renderWithPanes({ reviewActive: true });

			await openThreadWithEnter();

			expect(await cardInTheDiff()).toHaveTextContent(NOTE_OF.r1);
		});

		it("draws the active review's threads again once review mode ends", async () => {
			twoReviewsOnOneLine({ secondArchived: false });
			const view = render(RepoView, {
				props: { ...baseProps(createMockRemoteState()), reviewActive: true },
			});
			await showReview("Shown one");
			await openThreadWithEnter();

			await view.rerender({ reviewActive: false });
			await flush();

			expect(await cardInTheDiff()).toHaveTextContent(NOTE_OF.r1);
		});

		describe("when a refresh fails to read part of the store", () => {
			const lockedStore = '{"code":"store","message":"database is locked"}';

			beforeEach(_resetToasts);

			function renderOnAScheduler() {
				const scheduler = new FakeScheduler();
				render(RepoView, {
					props: { ...baseProps(createMockRemoteState()), reviewActive: true },
					context: new Map([[SCHEDULER, scheduler]]),
				});
				return scheduler;
			}

			// Resolves once the refresh has failed, which the toast it raises shows.
			async function refreshFailing(cmd: string, scheduler: FakeScheduler) {
				const answering = mockInvoke.getMockImplementation();
				if (!answering) throw new Error("two-review invoke missing");
				mockInvoke.mockImplementation((c, args) =>
					c === cmd ? Promise.reject(lockedStore) : answering(c, args),
				);

				fireReviewsChanged("/test/repo");
				scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
				await flush();

				expect(toasts.items).toContainEqual(
					expect.objectContaining({
						message: expect.stringContaining("database is locked"),
					}),
				);
			}

			it.each(["list_session_commits", "list_reviews"])(
				"keeps the active review's threads in the diff when %s fails",
				async (cmd) => {
					twoReviewsOnOneLine({ secondArchived: false });
					const scheduler = renderOnAScheduler();
					await openThreadWithEnter();

					await refreshFailing(cmd, scheduler);

					expect(await cardInTheDiff()).toHaveTextContent(NOTE_OF.r1);
				},
			);

			it("draws no threads in a picked review's diff when the review list fails", async () => {
				twoReviewsOnOneLine({ secondArchived: false });
				const scheduler = renderOnAScheduler();
				await showReview("Shown one");
				await openThreadWithEnter();

				await refreshFailing("list_reviews", scheduler);

				await screen.findByRole("button", { name: "Close diff" });
				expect(screen.queryByRole("article")).toBeNull();
			});
		});

		it("gives the branches back when review mode ends", async () => {
			const view = render(RepoView, {
				props: { ...baseProps(createMockRemoteState()), reviewActive: true },
			});
			await flush();

			await view.rerender({ reviewActive: false });
			await flush();

			expect(screen.getByTestId("branch-sidebar")).toBeVisible();
			expect(screen.queryByRole("navigation", { name: "Reviews" })).toBeNull();
		});
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
			tabActive: true,
			windowFocused: false,
			reviewActive: false,
			onreviewpanelshowingchange: vi.fn(),
			onleftpanecollapsedchange: vi.fn(),
			onrightpanecollapsedchange: vi.fn(),
			onleftpanewidthchange: vi.fn(),
			onrightpanewidthchange: vi.fn(),
			onleavereview: vi.fn(),
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
		const scheduler = new FakeScheduler();
		render(RepoView, {
			props: { ...baseProps(createMockRemoteState()), reviewActive: true },
			context: new Map([[SCHEDULER, scheduler]]),
		});
		await new Promise((r) => setTimeout(r, 0));
		scheduler.advanceBy(200);
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

	it("honors the selected filter on normal commit notes", async () => {
		const base = mockInvoke.getMockImplementation();
		if (!base) throw new Error("base invoke implementation missing");
		const commit = makeCommit({ oid: "oid-1", summary: "commit oid-1" });
		const detail: CommitDetailType = {
			oid: commit.oid,
			short_oid: commit.short_oid,
			summary: commit.summary,
			body: null,
			author_name: "Test",
			author_email: "test@test.com",
			author_timestamp: 0,
			committer_name: "Test",
			committer_email: "test@test.com",
			committer_timestamp: 0,
			parent_oids: [],
		};
		const doneNote = aThread({
			id: "done-note",
			review_id: "review-1",
			text: "done note",
			commit_oid: commit.oid,
			state: "done",
		});

		mockInvoke.mockImplementation((cmd, args) => {
			const a = args as Record<string, unknown> | undefined;
			switch (cmd) {
				case "get_commit_graph":
					return Promise.resolve({
						commits: [commit],
						max_columns: 1,
						revision: 1,
					});
				case "list_commit_files":
					return Promise.resolve([]);
				case "get_commit_detail":
					return a?.oid === commit.oid
						? Promise.resolve(detail)
						: Promise.reject("commit not found");
				case "list_reviews":
					return Promise.resolve([
						{
							id: "review-1",
							title: "Review",
							state: "open",
							visible_to_agent: false,
							thread_count: 1,
							unresolved_count: 1,
							pending_count: 0,
							created_at: 0,
						},
					]);
				case "get_active_review":
					return Promise.resolve("review-1");
				case "list_threads":
					return Promise.resolve([doneNote]);
				default:
					return base(cmd, args);
			}
		});

		render(RepoView, {
			props: {
				...baseProps(createMockRemoteState()),
				threadFilter: { states: ["open"], stale: true },
			},
		});

		await fireEvent.click(await screen.findByTestId("commit-row"));
		const note = await screen.findByText("done note");

		expect(note.closest("li")).toHaveStyle({
			display: "none",
		});
	});

	it("leaves automatic fetching to the application scheduler", async () => {
		const scheduler = new FakeScheduler();
		render(RepoView, {
			props: baseProps(createMockRemoteState()),
			context: new Map([[SCHEDULER, scheduler]]),
		});
		await vi.waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"get_commit_graph",
				expect.anything(),
			),
		);
		scheduler.advanceBy(600_000);
		await tick();
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"git_fetch_background",
			expect.anything(),
		);
	});

	it.each(["rebuild", "cached publication"] as const)(
		"reads WIP stats and stashes once during a whole repository %s",
		async (refreshKind) => {
			const scheduler = new FakeScheduler();
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base implementation missing");
			const graphCommand =
				refreshKind === "rebuild" ? "refresh_commit_graph" : "get_commit_graph";
			let initialGraphRead = false;
			let finishRefresh!: (value: unknown) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_commit_graph" && !initialGraphRead) {
					initialGraphRead = true;
					return Promise.resolve({
						commits: [makeCommit({ oid: "before", summary: "before refresh" })],
						max_columns: 1,
						revision: 1,
					});
				}
				if (cmd === graphCommand)
					return new Promise((resolve) => {
						finishRefresh = resolve;
					});
				if (cmd === "get_wip_diff_stats")
					return Promise.resolve({
						files_changed: 1,
						insertions: 1,
						deletions: 0,
					});
				return base(cmd, args);
			});
			render(RepoView, {
				props: baseProps(createMockRemoteState()),
				context: new Map([[SCHEDULER, scheduler]]),
			});
			await screen.findByText("before refresh");
			await vi.waitFor(() => {
				expect(mockInvoke).toHaveBeenCalledWith("get_wip_diff_stats", {
					path: "/test/repo",
				});
				expect(mockInvoke).toHaveBeenCalledWith("list_stashes", {
					path: "/test/repo",
				});
			});
			await tick();
			mockInvoke.mockClear();

			fireRepoChanged(
				"/test/repo",
				["readme"],
				refreshKind === "cached publication" ? { graph_revision: 2 } : {},
			);
			await tick();
			scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
			await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
			finishRefresh({
				commits: [makeCommit({ oid: "after", summary: "after refresh" })],
				max_columns: 1,
				revision: 2,
			});
			await screen.findByText("after refresh");
			scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
			await tick();

			const calls = (command: string) =>
				mockInvoke.mock.calls.filter(([cmd]) => cmd === command).length;
			expect({
				graph: calls(graphCommand),
				captures: calls("refresh_commit_graph"),
				wip: calls("get_wip_diff_stats"),
				stashes: calls("list_stashes"),
			}).toEqual({
				graph: 1,
				captures: refreshKind === "rebuild" ? 1 : 0,
				wip: 1,
				stashes: 1,
			});
		},
	);

	it.each([true, false])(
		"applies cached ref revisions without ref-triggered worktree scans (active=%s)",
		async (active) => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base implementation missing");
			let revision = 1;
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_commit_graph"
					? Promise.resolve({
							commits: [
								makeCommit({ oid: "oid-1", summary: `revision ${revision}` }),
							],
							max_columns: 1,
							revision,
						})
					: base(cmd, args),
			);
			const scheduler = new FakeScheduler();
			const props = {
				...baseProps(createMockRemoteState()),
				tabActive: active,
			};
			const view = render(RepoView, {
				props,
				context: new Map([[SCHEDULER, scheduler]]),
			});
			await screen.findByText("revision 1");
			await tick();
			scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
			await tick();
			mockInvoke.mockClear();
			revision = 3;
			fireRepoChanged("/test/repo", [], { refs_only: true, graph_revision: 2 });
			fireRepoChanged("/test/repo", [], { refs_only: true, graph_revision: 3 });
			await tick();
			scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
			await tick();
			if (!active) {
				for (const command of [
					"get_commit_graph",
					"get_status",
					"get_dirty_counts",
					"get_wip_diff_stats",
					"refresh_commit_graph",
					"list_stashes",
					"get_operation_state",
				]) {
					expect(
						mockInvoke.mock.calls.filter(([cmd]) => cmd === command),
					).toHaveLength(0);
				}
				expect(
					mockInvoke.mock.calls.filter(([cmd]) => cmd === "get_commit_graph"),
				).toHaveLength(0);
				expect(screen.queryByText("revision 1")).toBeTruthy();
				await view.rerender({ ...props, tabActive: true });
				scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
			}
			await screen.findByText("revision 3");
			expect(
				mockInvoke.mock.calls.filter(([cmd]) => cmd === "get_commit_graph"),
			).toHaveLength(1);
			for (const command of [
				"refresh_commit_graph",
				"get_status",
				"get_dirty_counts",
				"get_wip_diff_stats",
				"list_stashes",
				"get_operation_state",
				"diff_unstaged",
			]) {
				expect(
					mockInvoke.mock.calls.filter(([cmd]) => cmd === command),
				).toHaveLength(
					!active &&
						[
							"get_status",
							"get_dirty_counts",
							"get_operation_state",
							"get_wip_diff_stats",
						].includes(command)
						? 1
						: 0,
				);
			}
		},
	);

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
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: vi.fn(),
				onleftpanecollapsedchange: vi.fn(),
				onrightpanecollapsedchange: vi.fn(),
				onleftpanewidthchange: vi.fn(),
				onrightpanewidthchange: vi.fn(),
				onleavereview: vi.fn(),
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
			tabActive: true,
			windowFocused: false,
			reviewActive: false,
			onreviewpanelshowingchange: vi.fn(),
			onleftpanecollapsedchange: vi.fn(),
			onrightpanecollapsedchange: vi.fn(),
			onleftpanewidthchange: vi.fn(),
			onrightpanewidthchange: vi.fn(),
			onleavereview: vi.fn(),
		});

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		it("serializes a newer repository load behind the active read", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const scheduler = new FakeScheduler();
			const pending: ((counts: unknown) => void)[] = [];
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_dirty_counts"
					? new Promise((resolve) => pending.push(resolve))
					: base(cmd, args),
			);
			const { container, rerender } = render(RepoView, {
				props: props(),
				context: new Map([[SCHEDULER, scheduler]]),
			});
			await flush();
			await rerender({ ...props(), repoPath: "/test/other" });
			await flush();
			expect(pending).toHaveLength(1);

			pending[0]({ staged: 0, unstaged: 0, conflicted: 0 });
			await flush();
			scheduler.advanceBy(200);
			await flush();
			expect(pending).toHaveLength(2);
			pending[1]({ staged: 1, unstaged: 0, conflicted: 0 });
			await flush();

			expect(container.textContent).toContain("// WIP");
		});
	});

	describe("staging diff content mode", () => {
		// A later mock keeps the file listed, as the real status would while it
		// still has changes, so a status refresh does not close the open diff.
		function currentInvoke() {
			const impl = mockInvoke.getMockImplementation();
			if (!impl) throw new Error("invoke implementation missing");
			return impl;
		}

		function stagingDiff(content: string, path = "README.md"): FileDiff {
			return {
				path,
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [
					{
						header: "@@ -1,0 +1,1 @@",
						old_start: 1,
						old_lines: 0,
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

		it("keeps a file's diff open when its row is clicked again", async () => {
			const base = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("OPEN DIFF")]);
				}
				return base(cmd, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("OPEN DIFF")).toBeTruthy();

			await fireEvent.click(screen.getByRole("option", { name: /README\.md/ }));
			await tick();

			expect(screen.getByText("OPEN DIFF")).toBeTruthy();
		});

		describe("a review ended from its panel", () => {
			const README_STATUS = {
				unstaged: [{ path: "README.md", status: "Modified", is_binary: false }],
				staged: [],
				conflicted: [],
			};
			const CONFLICTED_STATUS = {
				unstaged: [],
				staged: [],
				conflicted: [
					{ path: "README.md", status: "Conflicted", is_binary: false },
				],
			};

			function twoHunkDiff(): FileDiff {
				const first = stagingDiff("FIRST HUNK").hunks[0];
				const second = {
					...stagingDiff("SECOND HUNK").hunks[0],
					header: "@@ -40,0 +40,1 @@",
					old_start: 40,
					new_start: 40,
				};
				second.lines = [{ ...second.lines[0], new_lineno: 40 }];
				return { ...stagingDiff("FIRST HUNK"), hunks: [first, second] };
			}

			function stubRepository(
				status: typeof README_STATUS | typeof CONFLICTED_STATUS,
				diff: FileDiff = stagingDiff("LEFT DIFF"),
			) {
				const base = currentInvoke();
				mockInvoke.mockImplementation((cmd, args) => {
					if (cmd === "get_status") return Promise.resolve(status);
					if (cmd === "diff_unstaged") return Promise.resolve([diff]);
					if (cmd === "get_merge_sides")
						return Promise.resolve({
							base: "line 1\ncommon line\n",
							ours: "line 1\nour change\n",
							theirs: "line 1\ntheir change\n",
						});
					return base(cmd, args);
				});
			}

			async function openReadmeInReview() {
				const props = {
					...baseProps(createMockRemoteState()),
					reviewActive: true,
				};
				const view = render(RepoView, { props });
				await fireEvent.click(await screen.findByText("README.md"));
				await vi.dynamicImportSettled();
				await tick();
				return {
					showPanel: async () => {
						fireReviewShowPanel();
						await tick();
					},
					endReview: async () => {
						await view.rerender({ ...props, reviewActive: false });
						await vi.dynamicImportSettled();
						await tick();
					},
				};
			}

			function diffScroller(): HTMLElement {
				const scroller = document.querySelector<HTMLElement>(
					".exact-virtual-viewport",
				);
				if (!scroller) throw new Error("diff scroller missing");
				return scroller;
			}

			it("returns to the diff where it was left", async () => {
				stubRepository(README_STATUS);
				const review = await openReadmeInReview();
				expect(await screen.findByText("LEFT DIFF")).toBeTruthy();
				const scroller = diffScroller();
				scroller.scrollTop = 120;
				await fireEvent.scroll(scroller);

				await review.showPanel();
				expect(scroller.closest(".invisible")).not.toBeNull();
				await review.endReview();

				expect(diffScroller()).toBe(scroller);
				expect(scroller.scrollTop).toBe(120);
				expect(scroller.closest(".invisible")).toBeNull();
			});

			it("keeps that diff through an Escape on the panel", async () => {
				stubRepository(README_STATUS);
				const review = await openReadmeInReview();
				const scroller = diffScroller();
				await review.showPanel();

				await fireEvent.keyDown(window, { key: "Escape" });
				await review.endReview();

				expect(diffScroller()).toBe(scroller);
				expect(screen.getByText("LEFT DIFF")).toBeTruthy();
			});

			it("leaves the diff's keys to the panel while the panel shows", async () => {
				stubRepository(README_STATUS, twoHunkDiff());
				const review = await openReadmeInReview();
				const scroller = diffScroller();
				await review.showPanel();

				await fireEvent.keyDown(window, { key: "]" });
				await tick();
				expect(scroller.scrollTop).toBe(0);

				await review.endReview();
				await fireEvent.keyDown(window, { key: "]" });
				await tick();
				expect(scroller.scrollTop).toBeGreaterThan(0);
			});

			// A rerender replaces every prop, which reloads the editor's sides, so
			// the sides it keeps through the review are observed in the app; this
			// pins that it stays mounted, hidden, while the panel shows.
			it("keeps the merge editor mounted under the panel", async () => {
				stubRepository(CONFLICTED_STATUS);
				const review = await openReadmeInReview();
				expect(await screen.findAllByText("our change")).not.toHaveLength(0);
				const editor = await screen.findByRole("button", {
					name: "Close merge editor",
				});

				await review.showPanel();

				expect(editor.isConnected).toBe(true);
				expect(editor.closest(".invisible")).not.toBeNull();
			});
		});

		describe("when another conflicted file is resolved from its menu", () => {
			function stubConflicts(paths: string[]) {
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) => {
					const a = args as Record<string, unknown> | undefined;
					if (cmd === "get_status")
						return Promise.resolve({
							unstaged: [],
							staged: [],
							conflicted: paths.map((path) => ({
								path,
								status: "Conflicted",
								is_binary: false,
							})),
						});
					if (cmd === "get_merge_sides") {
						const name = String(a?.filePath).replace(".txt", "");
						return Promise.resolve({
							base: "line 1\ncommon line\n",
							ours: `line 1\n${name} ours\n`,
							theirs: `line 1\n${name} theirs\n`,
						});
					}
					if (cmd === "save_merge_result") return Promise.resolve(null);
					return base(cmd, args);
				});
			}

			async function openConflict(path: string) {
				render(RepoView, { props: baseProps(createMockRemoteState()) });
				await fireEvent.click(await screen.findByText(path));
				await vi.dynamicImportSettled();
				await screen.findByRole("button", {
					name: "Take conflict 1 from Current (Ours)",
				});
			}

			async function takeAllCurrentFromMenu(path: string) {
				await fireEvent.contextMenu(screen.getByText(path));
				await vi.waitFor(() => getMenuAction("Take All Current"));
				await getMenuAction("Take All Current")();
				await vi.waitFor(() =>
					expect(mockInvoke).toHaveBeenCalledWith(
						"save_merge_result",
						expect.objectContaining({ filePath: path }),
					),
				);
				for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
			}

			it("keeps the merge editor on the file it shows", async () => {
				stubConflicts(["a.txt", "b.txt", "c.txt"]);
				await openConflict("b.txt");

				await takeAllCurrentFromMenu("a.txt");

				expect(screen.getAllByText("b ours")).not.toHaveLength(0);
				expect(screen.queryByText("c ours")).toBeNull();
			});

			it("moves the merge editor on when the file it shows is resolved", async () => {
				stubConflicts(["a.txt", "b.txt", "c.txt"]);
				await openConflict("b.txt");

				await takeAllCurrentFromMenu("b.txt");

				expect(await screen.findAllByText("c ours")).not.toHaveLength(0);
			});

			it("keeps the takes made in the file it shows", async () => {
				stubConflicts(["a.txt", "b.txt"]);
				await openConflict("b.txt");
				await fireEvent.click(
					screen.getByRole("button", {
						name: "Take conflict 1 from Current (Ours)",
					}),
				);

				await takeAllCurrentFromMenu("a.txt");

				expect(
					screen.getByRole("button", {
						name: "Take conflict 1 from Current (Ours)",
					}),
				).toHaveAttribute("aria-pressed", "true");
			});
		});

		it("keeps the newest staging mode when superseded requests settle later", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("INITIAL STAGING")]);
				}
				return base(cmd, args);
			});
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("INITIAL STAGING")).toBeTruthy();
			let resolveFull!: (files: FileDiff[]) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			const opened = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_unstaged") return opened(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve) => {
					if (options.showFullFile) resolveFull = resolve;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			expect(screen.queryByText("Loading diff…")).toBeFalsy();
			resolveFull([stagingDiff("STALE STAGING")]);
			await tick();
			expect(screen.queryByText("STALE STAGING")).toBeFalsy();
			await vi.waitFor(() => expect(resolveHunk).toBeTypeOf("function"));
			resolveHunk([stagingDiff("NEW STAGING")]);

			expect(await screen.findByText("NEW STAGING")).toBeTruthy();
			expect(screen.queryByText("STALE STAGING")).toBeFalsy();
		});

		// The watcher reports every write under the repository, so a concurrent
		// process touching an unrelated file used to refetch the diff on screen
		// (TRUNK-232). The refresh is coalesced behind a deadline, so the test
		// drives the scheduler rather than waiting on one.
		interface OpenDiff {
			scheduler: FakeScheduler;
			diffCalls: () => number;
			settle: () => Promise<void>;
		}

		async function openStagedReadme(): Promise<OpenDiff> {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let diffCalls = 0;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					diffCalls += 1;
					return Promise.resolve([stagingDiff("STABLE CONTENT")]);
				}
				return base(cmd, args);
			});

			const scheduler = new FakeScheduler();
			const settle = async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				scheduler.advanceBy(REPO_CHANGE_DELAY_MS);
				await new Promise((resolve) => setTimeout(resolve, 0));
			};

			render(RepoView, {
				props: baseProps(createMockRemoteState()),
				context: new Map([[SCHEDULER, scheduler]]),
			});
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("STABLE CONTENT")).toBeTruthy();
			await settle();

			return { scheduler, diffCalls: () => diffCalls, settle };
		}

		it("leaves the open diff alone when another file is written", async () => {
			const { diffCalls, settle } = await openStagedReadme();
			const before = diffCalls();

			fireRepoChanged("/test/repo", ["docs/unrelated.md"]);
			await settle();

			expect(diffCalls()).toBe(before);
			expect(screen.queryByText("STABLE CONTENT")).toBeTruthy();
		});

		it("refetches the open diff when its own file is written", async () => {
			const { diffCalls, settle } = await openStagedReadme();
			const before = diffCalls();

			fireRepoChanged("/test/repo", ["README.md"]);
			await settle();

			expect(diffCalls()).toBeGreaterThan(before);
		});

		// A staged diff reads the index rather than the working tree, so a commit
		// or a stage made elsewhere writes only under .git and would otherwise
		// leave the pane showing a diff that no longer exists.
		it("refetches the open diff when the index is written", async () => {
			const { diffCalls, settle } = await openStagedReadme();
			const before = diffCalls();

			fireRepoChanged("/test/repo", [".git/index"]);
			await settle();

			expect(diffCalls()).toBeGreaterThan(before);
		});

		describe("when Stage All moves the open file", () => {
			function mockStageAll(stagedElsewhere: boolean) {
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				const readme = {
					path: "README.md",
					status: "Modified",
					is_binary: false,
				};
				let staged = false;
				mockInvoke.mockImplementation((cmd, args) => {
					if (cmd === "stage_all") {
						staged = true;
						return Promise.resolve(undefined);
					}
					if (cmd === "get_status") {
						const inStaged = staged && stagedElsewhere;
						return Promise.resolve({
							unstaged: staged ? [] : [readme],
							staged: inStaged ? [readme] : [],
							conflicted: [],
						});
					}
					if (cmd === "diff_unstaged")
						return Promise.resolve([stagingDiff("UNSTAGED CONTENT")]);
					if (cmd === "diff_staged")
						return Promise.resolve([stagingDiff("STAGED CONTENT")]);
					return base(cmd, args);
				});
			}

			async function openReadmeThenStageAll() {
				render(RepoView, { props: baseProps(createMockRemoteState()) });
				await fireEvent.click(await screen.findByText("README.md"));
				expect(await screen.findByText("UNSTAGED CONTENT")).toBeTruthy();

				await fireEvent.click(
					screen.getByRole("button", { name: "Stage all changes" }),
				);
			}

			it("shows the file's staged diff", async () => {
				mockStageAll(true);

				await openReadmeThenStageAll();

				expect(await screen.findByText("STAGED CONTENT")).toBeTruthy();
				expect(screen.queryByText("UNSTAGED CONTENT")).toBeFalsy();
			});

			it("closes the diff when the file left both lists", async () => {
				mockStageAll(false);

				await openReadmeThenStageAll();

				await vi.waitFor(() =>
					expect(screen.queryByText("UNSTAGED CONTENT")).toBeFalsy(),
				);
				expect(
					screen.queryByRole("button", { name: "Stage File" }),
				).toBeFalsy();
				expect(screen.queryByText("STAGED CONTENT")).toBeFalsy();
			});
		});

		it("keeps the last unstaged file open in the staged list when it is staged", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const readme = {
				path: "README.md",
				status: "Modified",
				is_binary: false,
			};
			let staged = false;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "stage_file") {
					staged = true;
					return Promise.resolve(undefined);
				}
				if (cmd === "get_status")
					return Promise.resolve({
						unstaged: staged ? [] : [readme],
						staged: staged ? [readme] : [],
						conflicted: [],
					});
				if (cmd === "diff_unstaged")
					return Promise.resolve([stagingDiff("UNSTAGED CONTENT")]);
				if (cmd === "diff_staged")
					return Promise.resolve([stagingDiff("STAGED CONTENT")]);
				return base(cmd, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const row = await screen.findByText("README.md");
			await fireEvent.click(row);
			expect(await screen.findByText("UNSTAGED CONTENT")).toBeTruthy();
			const rowWithActions = row.closest(
				'[data-testid="staging-file"]',
			)?.parentElement;
			if (!rowWithActions) throw new Error("file row is detached");

			await fireEvent.click(
				within(rowWithActions).getByRole("button", { name: "Stage file" }),
			);

			expect(await screen.findByText("STAGED CONTENT")).toBeTruthy();
			expect(screen.queryByText("UNSTAGED CONTENT")).toBeFalsy();
		});

		describe("when Escape lands on a line selection", () => {
			async function openReadmeWithALineSelected() {
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) => {
					if (cmd === "get_status")
						return Promise.resolve({
							unstaged: [
								{ path: "README.md", status: "Modified", is_binary: false },
							],
							staged: [],
							conflicted: [],
						});
					if (cmd === "diff_unstaged")
						return Promise.resolve([stagingDiff("UNSTAGED CONTENT")]);
					return base(cmd, args);
				});
				render(RepoView, { props: baseProps(createMockRemoteState()) });
				await fireEvent.click(await screen.findByText("README.md"));
				const line = await screen.findByText("UNSTAGED CONTENT");
				const grip = line
					.closest(".diff-line")
					?.querySelector("[data-gutter-grip]");
				if (!grip) throw new Error("no gutter grip on the changed line");
				await fireEvent.mouseDown(grip);
				await fireEvent.mouseUp(window);
				expect(
					screen.getByRole("button", { name: /^Stage Lines/ }),
				).toBeTruthy();
			}

			it("clears the selection and keeps the diff open", async () => {
				await openReadmeWithALineSelected();

				await fireEvent.keyDown(window, { key: "Escape" });

				await vi.waitFor(() =>
					expect(
						screen.queryByRole("button", { name: /^Stage Lines/ }),
					).toBeNull(),
				);
				expect(screen.queryByText("UNSTAGED CONTENT")).toBeTruthy();
			});

			it("closes the diff on the next Escape", async () => {
				await openReadmeWithALineSelected();
				await fireEvent.keyDown(window, { key: "Escape" });

				await fireEvent.keyDown(window, { key: "Escape" });

				await vi.waitFor(() =>
					expect(screen.queryByText("UNSTAGED CONTENT")).toBeNull(),
				);
			});
		});

		describe("when the index changes under a line selection", () => {
			// Opens README.md with one changed line selected, its diff read by
			// `read` each time RepoView asks for it.
			async function openReadmeWithALineSelected(read: () => FileDiff[]) {
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) => {
					if (cmd === "get_status")
						return Promise.resolve({
							unstaged: [
								{ path: "README.md", status: "Modified", is_binary: false },
							],
							staged: [],
							conflicted: [],
						});
					if (cmd === "diff_unstaged") return Promise.resolve(read());
					return base(cmd, args);
				});
				render(RepoView, { props: baseProps(createMockRemoteState()) });
				await fireEvent.click(await screen.findByText("README.md"));
				const line = await screen.findByText("UNSTAGED CONTENT");
				const grip = line
					.closest(".diff-line")
					?.querySelector("[data-gutter-grip]");
				if (!grip) throw new Error("no gutter grip on the changed line");
				await fireEvent.mouseDown(grip);
				await fireEvent.mouseUp(window);
				expect(
					screen.getByRole("button", { name: /^Stage Lines/ }),
				).toBeTruthy();
			}

			it("keeps the selection when the open file's diff reads the same", async () => {
				let reads = 0;
				await openReadmeWithALineSelected(() => {
					reads += 1;
					return [stagingDiff("UNSTAGED CONTENT")];
				});
				const before = reads;

				fireRepoChanged("/test/repo", [".git/index"]);

				await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
				for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
				expect(
					screen.getByRole("button", { name: /^Stage Lines/ }),
				).toBeTruthy();
			});

			it("keeps the selection in a file opened from the finder when it reads the same", async () => {
				let reads = 0;
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) => {
					if (cmd === "list_tracked_files")
						return Promise.resolve([{ path: "src/alpha.ts", changed: false }]);
					if (cmd === "open_current_file") {
						reads += 1;
						return Promise.resolve([stagingDiff("ALPHA LINE", "src/alpha.ts")]);
					}
					if (cmd === "get_active_review") return Promise.resolve("r1");
					return base(cmd, args);
				});
				render(RepoView, {
					props: { ...baseProps(createMockRemoteState()), reviewActive: true },
				});
				await fireEvent.click(await screen.findByText(/Comment on a file/));
				await fireEvent.click(await findFinderOption());
				const grip = (await screen.findByText("ALPHA LINE"))
					.closest(".diff-line")
					?.querySelector("[data-gutter-grip]");
				if (!grip) throw new Error("no gutter grip on the file's line");
				await fireEvent.mouseDown(grip);
				await fireEvent.mouseUp(window);
				expect(
					screen.getByRole("button", { name: "Comment on selected lines" }),
				).toBeTruthy();
				const before = reads;

				fireRepoChanged("/test/repo", [".git/index"]);

				await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
				for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
				expect(
					screen.getByRole("button", { name: "Comment on selected lines" }),
				).toBeTruthy();
			});

			it("drops the selection when the open file's diff changed", async () => {
				let content = "UNSTAGED CONTENT";
				await openReadmeWithALineSelected(() => [stagingDiff(content)]);
				content = "EDITED CONTENT";

				fireRepoChanged("/test/repo", [".git/index"]);

				expect(await screen.findByText("EDITED CONTENT")).toBeTruthy();
				expect(
					screen.queryByRole("button", { name: /^Stage Lines/ }),
				).toBeNull();
			});
		});

		it("drops a Comment File read superseded by a same-file reload", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("INITIAL STAGING")]);
				}
				return base(cmd, args);
			});
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("INITIAL STAGING")).toBeTruthy();

			let resolveComment!: (files: FileDiff[]) => void;
			let fullReads = 0;
			const opened = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_unstaged") return opened(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				if (!options.showFullFile)
					return Promise.resolve([stagingDiff("NEW HUNK")]);

				fullReads += 1;
				return fullReads === 1
					? new Promise<FileDiff[]>((resolve) => {
							resolveComment = resolve;
						})
					: Promise.resolve([stagingDiff("NEW FULL")]);
			});

			await fireEvent.click(screen.getByText("Comment File"));
			await vi.waitFor(() => expect(resolveComment).toBeTypeOf("function"));
			await view.rerender({ ...props, contentMode: "full" });
			expect(await screen.findByText("NEW FULL")).toBeTruthy();
			resolveComment([stagingDiff("STALE COMMENT")]);
			await tick();

			expect(document.querySelector(".comment-composer textarea")).toBeNull();
		});

		it("ignores a superseded Comment File read failure", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("INITIAL STAGING")]);
				}
				return base(cmd, args);
			});
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("INITIAL STAGING")).toBeTruthy();

			let rejectComment!: (reason?: unknown) => void;
			let fullReads = 0;
			const opened = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_unstaged") return opened(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				if (!options.showFullFile)
					return Promise.resolve([stagingDiff("NEW HUNK")]);

				fullReads += 1;
				return fullReads === 1
					? new Promise<FileDiff[]>((_resolve, reject) => {
							rejectComment = reject;
						})
					: Promise.resolve([stagingDiff("NEW FULL")]);
			});

			_resetToasts();
			await fireEvent.click(screen.getByText("Comment File"));
			await vi.waitFor(() => expect(rejectComment).toBeTypeOf("function"));
			await view.rerender({ ...props, contentMode: "full" });
			expect(await screen.findByText("NEW FULL")).toBeTruthy();
			rejectComment(new Error("stale comment load failed"));
			await tick();

			expect(toasts.items).not.toContainEqual(
				expect.objectContaining({ message: "stale comment load failed" }),
			);
			expect(document.querySelector(".comment-composer textarea")).toBeNull();
		});

		it("ignores a stale staging failure while the newest mode is loading", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("INITIAL STAGING")]);
				}
				return base(cmd, args);
			});
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("INITIAL STAGING")).toBeTruthy();
			let rejectFull!: (reason?: unknown) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			const opened = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_unstaged") return opened(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve, reject) => {
					if (options.showFullFile) rejectFull = reject;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			rejectFull(new Error("stale full-file load failed"));
			await vi.waitFor(() => expect(resolveHunk).toBeTypeOf("function"));

			expect(screen.queryByText("Could not load diff")).toBeFalsy();
			resolveHunk([stagingDiff("NEW STAGING")]);
			expect(await screen.findByText("NEW STAGING")).toBeTruthy();
		});

		it("withholds the staging payload when the current mode reload fails", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.resolve([stagingDiff("OLD STAGING")]);
				}
				return base(cmd, args);
			});
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("README.md"));
			expect(await screen.findByText("OLD STAGING")).toBeTruthy();
			const opened = currentInvoke();
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_unstaged"
					? Promise.reject(new Error("staging full failed"))
					: opened(cmd, args),
			);

			await view.rerender({ ...props, contentMode: "full" });

			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.queryByText("OLD STAGING")).toBeFalsy();
		});

		it("shows a retryable error when the first staging load fails", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "README.md", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					return Promise.reject(
						JSON.stringify({
							code: "diff_failed",
							message: "first load failed",
						}),
					);
				}
				return base(cmd, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });

			await fireEvent.click(await screen.findByText("README.md"));

			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.getByText("first load failed")).toBeTruthy();
			expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		});

		it("ignores an empty staging response after the selected target changes", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let resolveFirst!: (files: FileDiff[]) => void;
			let resolveSecond!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd === "get_status") {
					return Promise.resolve({
						unstaged: [
							{ path: "first.ts", status: "Modified", is_binary: false },
							{ path: "second.ts", status: "Modified", is_binary: false },
						],
						staged: [],
						conflicted: [],
					});
				}
				if (cmd === "diff_unstaged") {
					const path = (args as { filePath: string }).filePath;
					return new Promise<FileDiff[]>((resolve) => {
						if (path === "first.ts") resolveFirst = resolve;
						else resolveSecond = resolve;
					});
				}
				return base(cmd, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });

			await fireEvent.click(await screen.findByText("first.ts"));
			await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
			await fireEvent.click(screen.getByText("second.ts"));
			resolveFirst([]);
			await tick();

			expect(await screen.findByText("Loading diff…")).toBeTruthy();
			await vi.waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
			resolveSecond([stagingDiff("SECOND TARGET", "second.ts")]);

			expect(await screen.findByText("SECOND TARGET")).toBeTruthy();
			expect(
				screen.queryByText("Select a file or commit to view its diff"),
			).toBeFalsy();
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
						return Promise.resolve({ commits, max_columns: 1, revision: 1 });
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

		it("keeps a commit file's diff open when its row is clicked again", async () => {
			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "OPEN DIFF");
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("OPEN DIFF")).toBeTruthy();

			await fireEvent.click(screen.getByRole("option", { name: /f\.ts/ }));
			await flush();

			expect(screen.getByText("OPEN DIFF")).toBeTruthy();
		});

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

		it("keeps the newest commit-file mode when reloads finish in reverse order", async () => {
			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "INITIAL");
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("INITIAL")).toBeTruthy();

			let resolveFull!: (files: FileDiff[]) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_commit_file") return base(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve) => {
					if (options.showFullFile) resolveFull = resolve;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			resolveHunk([makeFileDiffWithContent("f.ts", "NEWEST")]);
			expect(await screen.findByText("NEWEST")).toBeTruthy();
			resolveFull([makeFileDiffWithContent("f.ts", "STALE")]);
			await flush();

			expect(screen.queryByText("STALE")).toBeFalsy();
			expect(screen.getByText("NEWEST")).toBeTruthy();
		});

		it("ignores a stale commit-file failure while the newest mode is loading", async () => {
			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "INITIAL");
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("INITIAL")).toBeTruthy();
			let rejectFull!: (reason?: unknown) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_commit_file") return base(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve, reject) => {
					if (options.showFullFile) rejectFull = reject;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			rejectFull(new Error("stale full-file load failed"));
			await vi.waitFor(() => expect(resolveHunk).toBeTypeOf("function"));

			expect(screen.queryByText("Loading diff…")).toBeFalsy();
			expect(screen.queryByText("Could not load diff")).toBeFalsy();
			resolveHunk([makeFileDiffWithContent("f.ts", "NEWEST")]);
			expect(await screen.findByText("NEWEST")).toBeTruthy();
		});

		it("does not apply a commit-file response after its diff closes", async () => {
			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "INITIAL");
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("INITIAL")).toBeTruthy();
			let resolveDiff!: (files: FileDiff[]) => void;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_commit_file"
					? new Promise<FileDiff[]>((resolve) => {
							resolveDiff = resolve;
						})
					: base(cmd, args),
			);

			await view.rerender({ ...props, contentMode: "full" });
			await fireEvent.click(screen.getByLabelText("Close diff"));
			resolveDiff([makeFileDiffWithContent("f.ts", "CLOSED COMMIT")]);
			await flush();

			expect(screen.queryByText("CLOSED COMMIT")).toBeFalsy();
		});

		it("withholds the previous commit payload when the current mode reload fails", async () => {
			commits = [makeCommit({ oid: "oid-2", summary: "second commit" })];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2") };
			diffFor = (path) => makeFileDiffWithContent(path, "OLD HUNK");
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("OLD HUNK")).toBeTruthy();
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_commit_file"
					? Promise.reject(new Error("full load failed"))
					: base(cmd, args),
			);

			await view.rerender({ ...props, contentMode: "full" });

			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.queryByText("OLD HUNK")).toBeFalsy();
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_commit_file"
					? Promise.resolve([makeFileDiffWithContent("f.ts", "RETRIED FULL")])
					: base(cmd, args),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

			expect(await screen.findByText("RETRIED FULL")).toBeTruthy();
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

		it("keeps the shown diff until the next commit's diff lands when the pager steps", async () => {
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
			diffFor = (path) => makeFileDiffWithContent(path, "SECOND DIFF");
			await fireEvent.click(await screen.findByText("f.ts"));
			await screen.findByText("SECOND DIFF");
			let landFirst: ((diffs: FileDiff[]) => void) | undefined;
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_commit_file"
					? new Promise((resolve) => {
							landFirst = resolve;
						})
					: base(cmd, args),
			);

			await fireEvent.click(await screen.findByLabelText("Go to older commit"));
			await vi.waitFor(() => expect(landFirst).toBeTypeOf("function"));
			await flush();

			expect(screen.queryByText("Loading diff…")).toBeNull();
			expect(screen.getByText("SECOND DIFF")).toBeTruthy();
			expect(screen.getByText("commit oid-2")).toBeTruthy();
			landFirst?.([makeFileDiffWithContent("f.ts", "FIRST DIFF")]);
			expect(await screen.findByText("FIRST DIFF")).toBeTruthy();
			expect(screen.getByText("commit oid-1")).toBeTruthy();
			expect(screen.queryByText("commit oid-2")).toBeNull();
		});

		describe("when the pager steps while the next diff is read", () => {
			async function openSecondCommitDiff() {
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
				diffFor = (path) => makeFileDiffWithContent(path, "SECOND DIFF");
				await fireEvent.click(await screen.findByText("f.ts"));
				await screen.findByText("SECOND DIFF");
			}

			it("opens the commit with the read's failure when the diff cannot be read", async () => {
				await openSecondCommitDiff();
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) =>
					cmd === "diff_commit_file"
						? Promise.reject(new Error("read failed"))
						: base(cmd, args),
				);

				await fireEvent.click(
					await screen.findByLabelText("Go to older commit"),
				);

				expect(await screen.findByText("Could not load diff")).toBeTruthy();
				expect(screen.getByText("commit oid-1")).toBeTruthy();
				expect(screen.queryByText("SECOND DIFF")).toBeNull();
			});

			it("stays on the shown commit when the diff closes during the read", async () => {
				await openSecondCommitDiff();
				let landFirst: ((diffs: FileDiff[]) => void) | undefined;
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((cmd, args) =>
					cmd === "diff_commit_file"
						? new Promise((resolve) => {
								landFirst = resolve;
							})
						: base(cmd, args),
				);
				await fireEvent.click(
					await screen.findByLabelText("Go to older commit"),
				);
				await vi.waitFor(() => expect(landFirst).toBeTypeOf("function"));

				await fireEvent.click(screen.getByLabelText("Close diff"));
				landFirst?.([makeFileDiffWithContent("f.ts", "FIRST DIFF")]);

				await flush();

				expect(screen.getByText("commit oid-2")).toBeTruthy();
				expect(screen.queryByText("commit oid-1")).toBeNull();
				expect(screen.queryByText("FIRST DIFF")).toBeNull();
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
			expect(graphIsCovered()).toBe(true);
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

		it("returns to the graph rows it left, unread, when the diff closes", async () => {
			commits = [
				makeCommit({ oid: "oid-2", summary: "second commit" }),
				makeCommit({ oid: "oid-1", summary: "first commit" }),
			];
			filesByOid = { "oid-2": [makeFileDiff("f.ts")] };
			detailByOid = { "oid-2": makeDetail("oid-2", ["oid-1"]) };

			const rows = await renderAndGetRows();
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await flush();
			const graphReads = () =>
				mockInvoke.mock.calls.filter((c) => c[0] === "get_commit_graph").length;
			const readsWithDiffOpen = graphReads();
			expect(graphIsCovered()).toBe(true);
			const graph = rows[0].closest(".invisible");
			expect(graph?.contains(document.activeElement)).toBe(false);

			await fireEvent.click(await screen.findByLabelText("Close diff"));
			await flush();

			expect((await screen.findAllByTestId("commit-row"))[0]).toBe(rows[0]);
			expect(graphReads()).toBe(readsWithDiffOpen);
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

		function makeRebaseDetail(oid: string, summary: string): CommitDetailType {
			return {
				oid,
				short_oid: oid.slice(0, 7),
				summary,
				body: null,
				author_name: "Test",
				author_email: "test@test.com",
				author_timestamp: 0,
				committer_name: "Test",
				committer_email: "test@test.com",
				committer_timestamp: 0,
				parent_oids: [PARENT_OID],
			};
		}

		function makeRebaseFile(path: string): FileDiff {
			return {
				path,
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			};
		}

		function makeRebaseFileWithContent(
			path: string,
			content: string,
		): FileDiff {
			return {
				...makeRebaseFile(path),
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
							revision: 1,
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

		function stubBranchAt(name: string, oid: string) {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "list_refs":
						return Promise.resolve({
							local: [{ name }],
							remote: [],
							tags: [],
							stashes: [],
						});
					case "resolve_ref":
						return Promise.resolve(oid);
					default:
						return base(cmd, args);
				}
			});
		}

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		beforeEach(_resetToasts);

		async function openTheEditorOnTheClickedCommit(
			props = baseProps(createMockRemoteState()),
			waitForEditor = true,
		) {
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.contextMenu(rows[1]);
			await waitFor(() => {
				expect(menuActions.has("Interactive Rebase...")).toBe(true);
			});
			await getMenuAction("Interactive Rebase...")();
			if (waitForEditor)
				await screen.findByRole("listbox", { name: "Commits to rebase" });
			return view;
		}

		// Under jsdom the inert region carries the property and no attribute a
		// selector could find, so this reads the property.
		function insideInert(el: HTMLElement): boolean {
			for (let node: HTMLElement | null = el; node; node = node.parentElement)
				if ((node as HTMLElement & { inert?: boolean }).inert) return true;

			return false;
		}

		function rebaseRow(index: number): HTMLElement {
			const row = screen
				.getByRole("listbox", { name: "Commits to rebase" })
				.querySelector<HTMLElement>(`[data-rebase-row="${index}"]`);
			if (!row) throw new Error(`the plan has no row ${index}`);

			return row;
		}

		it("returns to the commit it left selected, unread, when the editor is cancelled", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((command, args) => {
				if (command === "get_commit_detail")
					return Promise.resolve(makeRebaseDetail(HEAD_OID, "head commit"));
				if (command === "list_commit_files") return Promise.resolve([]);
				return base(command, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.contextMenu(rows[1]);
			await waitFor(() => {
				expect(menuActions.has("Interactive Rebase...")).toBe(true);
			});
			await getMenuAction("Interactive Rebase...")();
			await screen.findByRole("listbox", { name: "Commits to rebase" });
			const graphReads = () =>
				mockInvoke.mock.calls.filter(([cmd]) => cmd === "get_commit_graph")
					.length;
			const readsWithEditorOpen = graphReads();

			await fireEvent.click(
				screen.getByRole("button", { name: "Cancel Rebase" }),
			);
			await flush();

			const [head] = await screen.findAllByTestId("commit-row");
			expect(head).toBe(rows[0]);
			expect(head).toHaveAttribute("aria-selected", "true");
			expect(graphReads()).toBe(readsWithEditorOpen);
		});

		it("leaves the commit selected under the editor where it was when j is pressed", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((command, args) => {
				if (command === "get_commit_detail")
					return Promise.resolve(makeRebaseDetail(HEAD_OID, "head commit"));
				if (command === "list_commit_files") return Promise.resolve([]);
				return base(command, args);
			});
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await flush();
			await fireEvent.contextMenu(rows[1]);
			await waitFor(() => {
				expect(menuActions.has("Interactive Rebase...")).toBe(true);
			});
			await getMenuAction("Interactive Rebase...")();
			await screen.findByRole("listbox", { name: "Commits to rebase" });

			await fireEvent.keyDown(window, { key: "j" });
			await flush();
			await fireEvent.click(
				screen.getByRole("button", { name: "Cancel Rebase" }),
			);
			await flush();

			const [head] = await screen.findAllByTestId("commit-row");
			expect(head).toHaveAttribute("aria-selected", "true");
		});

		it("leaves the commit selected in a background tab where it was when j is pressed", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((command, args) => {
				if (command === "get_commit_detail")
					return Promise.resolve(makeRebaseDetail(HEAD_OID, "head commit"));
				if (command === "list_commit_files") return Promise.resolve([]);
				return base(command, args);
			});
			const view = render(RepoView, {
				props: baseProps(createMockRemoteState()),
			});
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[0]);
			await screen.findByRole("button", { name: "Go to older commit" });
			await view.rerender({ tabActive: false });

			await fireEvent.keyDown(window, { key: "j" });
			await flush();
			await view.rerender({ tabActive: true });

			const [head] = await screen.findAllByTestId("commit-row");
			expect(head).toHaveAttribute("aria-selected", "true");
		});

		it("takes the graph out of focus and pointer reach under the editor", async () => {
			stubRebaseTodo(PARENT_OID);

			await openTheEditorOnTheClickedCommit();

			const [head] = screen.getAllByTestId("commit-row");
			expect(insideInert(head)).toBe(true);
		});

		it.each(["pending", "failed"] as const)(
			"can cancel a %s rebase editor load without starting the rebase",
			async (state) => {
				const loader = holdLazyModule("./RebaseEditor.svelte", "rebase editor");
				stubRebaseTodo(PARENT_OID);

				await openTheEditorOnTheClickedCommit(undefined, false);
				await loader[state]();

				await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
				await flush();

				expect(graphIsShown()).toBe(true);
				loader.expectCancelled();
				expect(
					mockInvoke.mock.calls.some(
						([command]) => command === "start_interactive_rebase",
					),
				).toBe(false);
			},
		);

		it.each(["pending", "failed"] as const)(
			"keeps the rebase plan when a %s commit detail module is cancelled",
			async (state) => {
				const loader = holdLazyModule(
					"./CommitDetail.svelte",
					"commit details",
				);
				stubRebaseTodo(PARENT_OID);
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				mockInvoke.mockImplementation((command, args) => {
					const request = args as Record<string, unknown> | undefined;
					if (
						command === "get_commit_detail" &&
						typeof request?.oid === "string"
					)
						return Promise.resolve(
							makeRebaseDetail(request.oid, "focused commit"),
						);
					return base(command, args);
				});

				await openTheEditorOnTheClickedCommit();
				await loader[state]();

				await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

				expect(
					screen.getByRole("button", { name: "Start Rebase" }),
				).toBeInTheDocument();
				loader.expectCancelled();
			},
		);

		it.each(["pending", "failed"] as const)(
			"returns to the rebase plan when a %s diff module is cancelled",
			async (state) => {
				const loader = holdLazyModule("./DiffPanel.svelte", "diff");
				stubRebaseTodo(PARENT_OID);
				const base = mockInvoke.getMockImplementation();
				if (!base) throw new Error("base invoke implementation missing");
				const file = makeRebaseFile("src/rebase.ts");
				mockInvoke.mockImplementation((command, args) => {
					const request = args as Record<string, unknown> | undefined;
					if (
						command === "get_commit_detail" &&
						typeof request?.oid === "string"
					)
						return Promise.resolve(
							makeRebaseDetail(request.oid, "focused commit"),
						);
					if (command === "list_commit_files") return Promise.resolve([file]);
					if (command === "diff_commit_file") return Promise.resolve([file]);
					return base(command, args);
				});

				await openTheEditorOnTheClickedCommit();
				await fireEvent.click(await screen.findByText(file.path));
				await loader[state]();

				await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

				loader.expectCancelled();
				expect(
					screen.getByRole("button", { name: "Start Rebase" }),
				).toBeInTheDocument();
				expect(
					mockInvoke.mock.calls.some(
						([command]) => command === "start_interactive_rebase",
					),
				).toBe(false);
			},
		);

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

		it("names the base by the branch that points at it", async () => {
			stubRebaseTodo(PARENT_OID);
			stubBranchAt("release", PARENT_OID);

			await openTheEditorOnTheClickedCommit();

			expect(
				await within(
					screen.getByRole("region", { name: "Interactive rebase" }),
				).findByRole("button", { name: "release" }),
			).toBeTruthy();
		});

		it("names a base no branch points at by its short SHA", async () => {
			stubRebaseTodo(PARENT_OID);

			await openTheEditorOnTheClickedCommit();

			expect(
				await screen.findByRole("button", { name: PARENT_OID.slice(0, 7) }),
			).toBeTruthy();
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

		it("keeps the newest rebase focus when the previous focus resolves last", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let resolveStaleDetail: ((detail: CommitDetailType) => void) | undefined;
			let resolveStaleFiles: ((files: FileDiff[]) => void) | undefined;
			const staleDetail = new Promise<CommitDetailType>((resolve) => {
				resolveStaleDetail = resolve;
			});
			const staleFiles = new Promise<FileDiff[]>((resolve) => {
				resolveStaleFiles = resolve;
			});
			const focusedFile = makeRebaseFile("src/clicked.ts");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && a?.oid === HEAD_OID) {
					return staleDetail;
				}
				if (cmd === "list_commit_files" && a?.oid === HEAD_OID) {
					return staleFiles;
				}
				if (cmd === "get_commit_detail" && a?.oid === CLICKED_OID) {
					return Promise.resolve(
						makeRebaseDetail(CLICKED_OID, "clicked commit"),
					);
				}
				if (cmd === "list_commit_files" && a?.oid === CLICKED_OID) {
					return Promise.resolve([focusedFile]);
				}
				return base(cmd, args);
			});

			await openTheEditorOnTheClickedCommit();
			if (!resolveStaleDetail || !resolveStaleFiles) {
				throw new Error("the initial rebase focus did not enter its barriers");
			}
			await fireEvent.click(rebaseRow(1));
			expect(await screen.findByText(focusedFile.path)).toBeTruthy();

			resolveStaleDetail(makeRebaseDetail(HEAD_OID, "head commit"));
			resolveStaleFiles([makeRebaseFile("src/head.ts")]);
			await flush();

			expect(screen.queryByText("src/head.ts")).toBeFalsy();
			expect(screen.getByText(focusedFile.path)).toBeTruthy();
			await fireEvent.click(screen.getByText(focusedFile.path));
			expect(mockInvoke).toHaveBeenCalledWith(
				"diff_commit_file",
				expect.objectContaining({
					oid: CLICKED_OID,
					filePath: focusedFile.path,
				}),
			);
		});

		it("keeps the newest rebase focus when the previous focus rejects last", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let rejectStaleDetail: ((reason?: unknown) => void) | undefined;
			const staleDetail = new Promise<CommitDetailType>((_resolve, reject) => {
				rejectStaleDetail = reject;
			});
			const focusedFile = makeRebaseFile("src/clicked.ts");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && a?.oid === HEAD_OID) {
					return staleDetail;
				}
				if (cmd === "list_commit_files" && a?.oid === HEAD_OID) {
					return Promise.resolve([makeRebaseFile("src/head.ts")]);
				}
				if (cmd === "get_commit_detail" && a?.oid === CLICKED_OID) {
					return Promise.resolve(
						makeRebaseDetail(CLICKED_OID, "clicked commit"),
					);
				}
				if (cmd === "list_commit_files" && a?.oid === CLICKED_OID) {
					return Promise.resolve([focusedFile]);
				}
				return base(cmd, args);
			});

			await openTheEditorOnTheClickedCommit();
			if (!rejectStaleDetail) {
				throw new Error("the initial rebase focus did not enter its barrier");
			}
			await fireEvent.click(rebaseRow(1));
			expect(await screen.findByText(focusedFile.path)).toBeTruthy();

			rejectStaleDetail(new Error("stale focus failed"));
			await flush();

			expect(screen.getByText(focusedFile.path)).toBeTruthy();
		});

		// Focuses the clicked commit, then HEAD with HEAD's files held, and opens
		// `path` from the clicked commit's list still on screen.
		async function pickAFileWhileHeadsFilesLoad(path: string) {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let holdHeadFiles = false;
			const headFilesAsked = Promise.withResolvers<void>();
			const headFiles = Promise.withResolvers<FileDiff[]>();
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, `summary ${a.oid}`));
				}
				if (
					cmd === "list_commit_files" &&
					a?.oid === HEAD_OID &&
					holdHeadFiles
				) {
					headFilesAsked.resolve();
					return headFiles.promise;
				}
				if (cmd === "list_commit_files") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					return Promise.resolve([
						makeRebaseFileWithContent(path, `DIFF AT ${String(a?.oid)}`),
					]);
				}
				return base(cmd, args);
			});
			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await screen.findByText(`summary ${CLICKED_OID}`);
			holdHeadFiles = true;
			await fireEvent.click(rebaseRow(0));
			await headFilesAsked.promise;
			await fireEvent.click(await screen.findByText(path));
			await screen.findByRole("button", { name: "Close diff" });

			return headFiles;
		}

		it("shows the newly focused commit's diff of a file picked while its files load", async () => {
			const path = "src/shared.ts";
			const headFiles = await pickAFileWhileHeadsFilesLoad(path);

			headFiles.resolve([makeRebaseFile(path)]);

			expect(await screen.findByText(`DIFF AT ${HEAD_OID}`)).toBeTruthy();
			expect(screen.queryByText(`DIFF AT ${CLICKED_OID}`)).toBeFalsy();
		});

		it("closes the diff of a file picked while its files load when the newly focused commit lacks it", async () => {
			const headFiles = await pickAFileWhileHeadsFilesLoad("src/shared.ts");

			headFiles.resolve([makeRebaseFile("src/head-only.ts")]);

			expect(await screen.findByText("src/head-only.ts")).toBeTruthy();
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull(),
			);
		});

		it("closes the diff of a file picked while the newly focused commit fails to load", async () => {
			const headFiles = await pickAFileWhileHeadsFilesLoad("src/shared.ts");

			headFiles.reject(new Error("list failed"));

			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull(),
			);
		});

		async function openARebaseFileDiff(path: string) {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					return Promise.resolve([
						makeRebaseFileWithContent(path, "REBASE DIFF"),
					]);
				}
				return base(cmd, args);
			});
			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(path));
			await screen.findByText("REBASE DIFF");
		}

		it("keeps a rebase file's diff open when its row is clicked again", async () => {
			const path = "src/rebase.ts";
			await openARebaseFileDiff(path);

			await fireEvent.click(screen.getByRole("option", { name: /rebase\.ts/ }));
			await flush();

			expect(screen.getByText("REBASE DIFF")).toBeTruthy();
		});

		it("reads a rebase file once when its row is clicked again", async () => {
			const path = "src/rebase.ts";
			await openARebaseFileDiff(path);

			await fireEvent.click(screen.getByRole("option", { name: /rebase\.ts/ }));
			await flush();

			const reads = mockInvoke.mock.calls.filter(
				(c) => c[0] === "diff_commit_file",
			);
			expect(reads).toHaveLength(1);
		});

		it("opens a rebase file again with one click after its diff is closed", async () => {
			const path = "src/rebase.ts";
			await openARebaseFileDiff(path);
			await fireEvent.click(
				await screen.findByRole("button", { name: "Close diff" }),
			);
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull(),
			);

			await fireEvent.click(screen.getByText(path));

			expect(await screen.findByText("REBASE DIFF")).toBeTruthy();
		});

		it("closes a rebase file's diff on Escape and keeps the plan", async () => {
			await openARebaseFileDiff("src/rebase.ts");

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(screen.queryByText("REBASE DIFF")).toBeNull();
			expect(
				screen.getByRole("listbox", { name: "Commits to rebase" }),
			).toBeTruthy();
		});

		it("keeps the plan through an Escape with no rebase diff open", async () => {
			stubRebaseTodo(PARENT_OID);
			await openTheEditorOnTheClickedCommit();

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(
				screen.getByRole("listbox", { name: "Commits to rebase" }),
			).toBeTruthy();
		});

		it("keeps the newest rebase diff options when older reloads finish last", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const path = "src/rebase.ts";
			let diffCall = 0;
			let resolveOld: ((files: FileDiff[]) => void) | undefined;
			let resolveNew: ((files: FileDiff[]) => void) | undefined;
			let rejectOld: ((reason?: unknown) => void) | undefined;
			let resolveNewest: ((files: FileDiff[]) => void) | undefined;
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files" && typeof a?.oid === "string") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					diffCall++;
					if (diffCall === 1) {
						return Promise.resolve([
							makeRebaseFileWithContent(path, "INITIAL"),
						]);
					}
					if (diffCall === 2) {
						return new Promise<FileDiff[]>((resolve) => {
							resolveOld = resolve;
						});
					}
					if (diffCall === 3) {
						return new Promise<FileDiff[]>((resolve) => {
							resolveNew = resolve;
						});
					}
					if (diffCall === 4) {
						return new Promise<FileDiff[]>((_resolve, reject) => {
							rejectOld = reject;
						});
					}
					return new Promise<FileDiff[]>((resolve) => {
						resolveNewest = resolve;
					});
				}
				return base(cmd, args);
			});

			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(path));
			expect(await screen.findByText("INITIAL")).toBeTruthy();
			await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
			await fireEvent.click(screen.getByTitle("Show full file"));
			if (!resolveOld || !resolveNew) {
				throw new Error("the first rebase diff reload pair did not enter");
			}
			resolveNew([makeRebaseFileWithContent(path, "NEWEST")]);
			expect(await screen.findByText("NEWEST")).toBeTruthy();
			resolveOld([makeRebaseFileWithContent(path, "STALE")]);
			await flush();
			expect(screen.queryByText("STALE")).toBeFalsy();

			await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
			await fireEvent.click(screen.getByTitle("Show hunks"));
			if (!rejectOld || !resolveNewest) {
				throw new Error("the second rebase diff reload pair did not enter");
			}
			resolveNewest([makeRebaseFileWithContent(path, "LATEST")]);
			expect(await screen.findByText("LATEST")).toBeTruthy();
			rejectOld(new Error("stale diff failed"));
			await flush();
			expect(toasts.items).not.toContainEqual(
				expect.objectContaining({
					message: "stale diff failed",
					kind: "error",
				}),
			);
		});

		it("withholds the rebase payload when the current mode reload fails", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const path = "src/rebase.ts";
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files" && typeof a?.oid === "string") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					return Promise.resolve([
						makeRebaseFileWithContent(path, "OLD REBASE"),
					]);
				}
				return base(cmd, args);
			});
			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(path));
			expect(await screen.findByText("OLD REBASE")).toBeTruthy();
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_commit_file"
					? Promise.reject(new Error("rebase full failed"))
					: base(cmd, args),
			);

			await fireEvent.click(screen.getByTitle("Show full file"));

			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.queryByText("OLD REBASE")).toBeFalsy();
		});

		it("hides a retained rebase hunk payload while that file's full content loads", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const first = "src/first.ts";
			const second = "src/second.ts";
			const firstFullRequested = Promise.withResolvers<void>();
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files" && typeof a?.oid === "string") {
					return Promise.resolve([
						makeRebaseFile(first),
						makeRebaseFile(second),
					]);
				}
				if (cmd === "diff_commit_file") {
					const request = args as {
						filePath: string;
						options: DiffRequestOptions;
					};
					const path = request.filePath;
					const full = request.options.showFullFile;
					if (path === first && full) {
						firstFullRequested.resolve();
						return new Promise<FileDiff[]>(() => {});
					}
					return Promise.resolve([
						makeRebaseFileWithContent(
							path,
							`${path} ${full ? "FULL" : "HUNK"}`,
						),
					]);
				}
				return base(cmd, args);
			});
			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(first));
			expect(await screen.findByText(`${first} HUNK`)).toBeTruthy();
			await fireEvent.click(screen.getByText(second));
			expect(await screen.findByText(`${second} HUNK`)).toBeTruthy();
			await fireEvent.click(screen.getByTitle("Show full file"));
			expect(await screen.findByText(`${second} FULL`)).toBeTruthy();

			await fireEvent.click(screen.getByText(first));
			await firstFullRequested.promise;

			expect(screen.queryByText(`${first} HUNK`)).toBeFalsy();
			expect(screen.getByText("Loading diff…")).toBeTruthy();
		});

		it("keeps a rebase file on screen while it reloads in the same mode", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const path = "src/rebase.ts";
			const filteredRequested = Promise.withResolvers<void>();
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files" && typeof a?.oid === "string") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					const request = args as { options: DiffRequestOptions };
					if (request.options.ignoreWhitespace) {
						filteredRequested.resolve();
						return new Promise<FileDiff[]>(() => {});
					}
					return Promise.resolve([
						makeRebaseFileWithContent(path, "ORIGINAL REBASE"),
					]);
				}
				return base(cmd, args);
			});
			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(path));
			expect(await screen.findByText("ORIGINAL REBASE")).toBeTruthy();

			await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
			await filteredRequested.promise;

			expect(screen.getByText("ORIGINAL REBASE")).toBeVisible();
		});

		it("does not apply a rebase diff response after its file closes", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const path = "src/rebase.ts";
			let resolveDiff!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && typeof a?.oid === "string") {
					return Promise.resolve(makeRebaseDetail(a.oid, "focused commit"));
				}
				if (cmd === "list_commit_files" && typeof a?.oid === "string") {
					return Promise.resolve([makeRebaseFile(path)]);
				}
				if (cmd === "diff_commit_file") {
					return new Promise<FileDiff[]>((resolve) => {
						resolveDiff = resolve;
					});
				}
				return base(cmd, args);
			});

			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await fireEvent.click(await screen.findByText(path));
			await vi.waitFor(() => expect(resolveDiff).toBeTypeOf("function"));
			await screen.findByText("Loading diff…");
			await fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
			resolveDiff([makeRebaseFileWithContent(path, "CLOSED REBASE")]);
			await flush();

			expect(screen.queryByText("CLOSED REBASE")).toBeFalsy();
			expect(screen.queryByText("Loading diff…")).toBeFalsy();
		});

		it("matches review comments in the focused rebase diff", async () => {
			stubRebaseTodo(PARENT_OID);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const fileDiff: FileDiff = {
				path: "src/rebase.ts",
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
								content: "const rebase = true;",
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			};
			const detail: CommitDetailType = {
				oid: CLICKED_OID,
				short_oid: CLICKED_OID.slice(0, 7),
				summary: "clicked commit",
				body: null,
				author_name: "Test",
				author_email: "test@test.com",
				author_timestamp: 0,
				committer_name: "Test",
				committer_email: "test@test.com",
				committer_timestamp: 0,
				parent_oids: [PARENT_OID],
			};
			const thread = aThread({
				id: "rebase-thread",
				review_id: "review-1",
				text: "rebase comment",
				anchor: {
					commit_oid: CLICKED_OID,
					file_path: fileDiff.path,
					source: "Diff",
					side: "New",
					start_line: 1,
					end_line: 1,
				},
			});
			mockInvoke.mockImplementation((cmd, args) => {
				const a = args as Record<string, unknown> | undefined;
				if (cmd === "get_commit_detail" && a?.oid === CLICKED_OID) {
					return Promise.resolve(detail);
				}
				if (cmd === "list_commit_files" && a?.oid === CLICKED_OID) {
					return Promise.resolve([fileDiff]);
				}
				if (cmd === "diff_commit_file" && a?.oid === CLICKED_OID) {
					return Promise.resolve([fileDiff]);
				}
				if (cmd === "list_reviews") {
					return Promise.resolve([
						{
							id: "review-1",
							title: "Review",
							state: "open",
							visible_to_agent: false,
							thread_count: 1,
							unresolved_count: 1,
							pending_count: 0,
							created_at: 0,
						},
					]);
				}
				if (cmd === "get_active_review") return Promise.resolve("review-1");
				if (cmd === "list_threads") return Promise.resolve([thread]);
				return base(cmd, args);
			});

			await openTheEditorOnTheClickedCommit();
			await fireEvent.click(rebaseRow(1));
			await screen.findByText("src/rebase.ts");
			await fireEvent.click(screen.getByText("src/rebase.ts"));

			expect(
				(await screen.findAllByText("rebase comment")).length,
			).toBeGreaterThan(0);
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

		function makeFileDiffWithContent(path: string, content: string): FileDiff {
			const diff = makeFileDiff(path);
			diff.hunks = [
				{
					header: "@@ -1,0 +1,1 @@",
					old_start: 1,
					old_lines: 0,
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
			];
			return diff;
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
						return Promise.resolve({ commits, max_columns: 1, revision: 1 });
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

		it.each(["pending", "failed"] as const)(
			"returns to staging when a %s commit detail module is cancelled",
			async (state) => {
				const loader = holdLazyModule(
					"./CommitDetail.svelte",
					"commit details",
				);
				render(RepoView, {
					props: baseProps(createMockRemoteState()),
				});

				const rows = await screen.findAllByTestId("commit-row");
				await fireEvent.click(rows[0]);
				await loader[state]();

				await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

				expect(
					await screen.findByRole("button", { name: "Commit" }),
				).toBeInTheDocument();
				loader.expectCancelled();
			},
		);

		it.each(["pending", "failed"] as const)(
			"returns to commit details when a %s comparison module is cancelled",
			async (state) => {
				const loader = holdLazyModule("./ComparePanel.svelte", "comparison");
				render(RepoView, {
					props: baseProps(createMockRemoteState()),
				});

				const rows = await screen.findAllByTestId("commit-row");
				await fireEvent.click(rows[2]);
				await screen.findByLabelText("Close commit detail");
				await fireEvent.click(rows[0], { metaKey: true });
				await loader[state]();

				await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

				expect(
					await screen.findByLabelText("Close commit detail"),
				).toBeInTheDocument();
				loader.expectCancelled();
			},
		);

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

		it("keeps a compare file's diff open when its row is clicked again", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await screen.findByRole("button", { name: "Close diff" });

			await fireEvent.click(screen.getByRole("option", { name: /f\.ts/ }));
			await flush();

			expect(screen.getByRole("button", { name: "Close diff" })).toBeTruthy();
		});

		it("reads a compare file once when its row is clicked again", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			await fireEvent.click(await screen.findByText("f.ts"));
			await screen.findByRole("button", { name: "Close diff" });

			await fireEvent.click(screen.getByRole("option", { name: /f\.ts/ }));
			await flush();

			const reads = mockInvoke.mock.calls.filter(
				(c) => c[0] === "diff_compare_file",
			);
			expect(reads).toHaveLength(1);
		});

		it("keeps the newest compare mode when reloads finish in reverse order", async () => {
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			await fireEvent.click(await screen.findByText("f.ts"));
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let resolveFull!: (files: FileDiff[]) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_compare_file") return base(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve) => {
					if (options.showFullFile) resolveFull = resolve;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			resolveHunk([makeFileDiffWithContent("f.ts", "NEW COMPARE")]);
			expect(await screen.findByText("NEW COMPARE")).toBeTruthy();
			resolveFull([makeFileDiffWithContent("f.ts", "STALE COMPARE")]);
			await flush();

			expect(screen.queryByText("STALE COMPARE")).toBeFalsy();
			expect(screen.getByText("NEW COMPARE")).toBeTruthy();
		});

		it("ignores a stale compare failure while the newest mode is loading", async () => {
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			await fireEvent.click(await screen.findByText("f.ts"));
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let rejectFull!: (reason?: unknown) => void;
			let resolveHunk!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_compare_file") return base(cmd, args);
				const options = (args as { options: { showFullFile: boolean } })
					.options;
				return new Promise<FileDiff[]>((resolve, reject) => {
					if (options.showFullFile) rejectFull = reject;
					else resolveHunk = resolve;
				});
			});

			await view.rerender({ ...props, contentMode: "full" });
			await view.rerender({ ...props, contentMode: "hunk" });
			rejectFull(new Error("stale compare load failed"));
			await vi.waitFor(() => expect(resolveHunk).toBeTypeOf("function"));

			expect(screen.queryByText("Could not load diff")).toBeFalsy();
			resolveHunk([makeFileDiffWithContent("f.ts", "NEW COMPARE")]);
			expect(await screen.findByText("NEW COMPARE")).toBeTruthy();
		});

		it("withholds the compare payload when the current mode reload fails", async () => {
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_compare_file"
					? Promise.resolve([makeFileDiffWithContent("f.ts", "OLD COMPARE")])
					: base(cmd, args),
			);
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("OLD COMPARE")).toBeTruthy();
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_compare_file"
					? Promise.reject(new Error("compare full failed"))
					: base(cmd, args),
			);

			await view.rerender({ ...props, contentMode: "full" });

			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
			expect(screen.queryByText("OLD COMPARE")).toBeFalsy();
		});

		it("does not apply a compare response after its file closes", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let resolveDiff!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_compare_file"
					? new Promise<FileDiff[]>((resolve) => {
							resolveDiff = resolve;
						})
					: base(cmd, args),
			);
			await fireEvent.click(await screen.findByText("f.ts"));
			await fireEvent.click(await screen.findByLabelText("Close diff"));

			resolveDiff([makeFileDiffWithContent("f.ts", "CLOSED COMPARE")]);
			await flush();

			expect(screen.queryByText("CLOSED COMPARE")).toBeFalsy();
		});

		it("does not apply a compare response after switching files", async () => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "list_compare_files"
					? Promise.resolve([makeFileDiff("f.ts"), makeFileDiff("g.ts")])
					: base(cmd, args),
			);
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			let resolveF!: (files: FileDiff[]) => void;
			let resolveG!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_compare_file") return base(cmd, args);
				const path = (args as { filePath: string }).filePath;
				return new Promise<FileDiff[]>((resolve) => {
					if (path === "f.ts") resolveF = resolve;
					else resolveG = resolve;
				});
			});

			await fireEvent.click(await screen.findByText("f.ts"));
			await fireEvent.click(await screen.findByText("g.ts"));
			await screen.findByText("Loading diff…");
			resolveF([makeFileDiffWithContent("f.ts", "OLD FILE")]);
			await flush();
			expect(screen.queryByText("OLD FILE")).toBeFalsy();
			resolveG([makeFileDiffWithContent("g.ts", "NEW FILE")]);

			expect(await screen.findByText("NEW FILE")).toBeTruthy();
		});

		it("does not apply a compare response after the pair swaps", async () => {
			const props = {
				...baseProps(createMockRemoteState()),
				contentMode: "hunk" as const,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			await fireEvent.click(await screen.findByText("f.ts"));
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let resolveDiff!: (files: FileDiff[]) => void;
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "diff_compare_file"
					? new Promise<FileDiff[]>((resolve) => {
							resolveDiff = resolve;
						})
					: base(cmd, args),
			);

			await view.rerender({ ...props, contentMode: "full" });
			await fireEvent.click(
				await screen.findByLabelText("Swap comparison direction"),
			);
			resolveDiff([makeFileDiffWithContent("f.ts", "OLD PAIR")]);
			await flush();

			expect(screen.queryByText("OLD PAIR")).toBeFalsy();
			expect(await screen.findByTestId("compare-header")).toHaveTextContent(
				"oid-3",
			);
		});

		it("keeps the open file open when the pair swaps", async () => {
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					contentMode: "hunk" as const,
					oncontentmodechange: vi.fn(),
				},
			});
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			await fireEvent.click(rows[0], { metaKey: true });
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_compare_file") return base(cmd, args);
				const pair = args as { baseOid: string; targetOid: string };
				return Promise.resolve([
					makeFileDiffWithContent(
						"f.ts",
						`${pair.baseOid} TO ${pair.targetOid}`,
					),
				]);
			});
			await fireEvent.click(await screen.findByText("f.ts"));
			const opened = (await screen.findByText(/ TO /)).textContent ?? "";
			const [from, to] = opened.split(" TO ");

			await fireEvent.click(
				await screen.findByLabelText("Swap comparison direction"),
			);

			expect(await screen.findByText(`${to} TO ${from}`)).toBeTruthy();
		});

		it("reopens a renamed file under its name in the swapped direction", async () => {
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					contentMode: "hunk" as const,
					oncontentmodechange: vi.fn(),
				},
			});
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const forward = { baseOid: "" };
			mockInvoke.mockImplementation((cmd, args) => {
				const pair = args as { baseOid: string; filePath: string };
				if (cmd === "list_compare_files") {
					forward.baseOid ||= pair.baseOid;
					const renamed =
						pair.baseOid === forward.baseOid
							? { path: "new.ts", old_path: "old.ts" }
							: { path: "old.ts", old_path: "new.ts" };
					return Promise.resolve([
						{ ...makeFileDiff(renamed.path), ...renamed, status: "Renamed" },
					]);
				}
				if (cmd === "diff_compare_file")
					return Promise.resolve([
						makeFileDiffWithContent(pair.filePath, `DIFF OF ${pair.filePath}`),
					]);
				return base(cmd, args);
			});
			await fireEvent.click(rows[0], { metaKey: true });
			await fireEvent.click(await screen.findByText("new.ts"));
			expect(await screen.findByText("DIFF OF new.ts")).toBeTruthy();

			await fireEvent.click(
				await screen.findByLabelText("Swap comparison direction"),
			);

			expect(await screen.findByText("DIFF OF old.ts")).toBeTruthy();
		});

		it("keeps a file picked while the swap loads", async () => {
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					contentMode: "hunk" as const,
					oncontentmodechange: vi.fn(),
				},
			});
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let release!: () => void;
			let lists = 0;
			mockInvoke.mockImplementation((cmd, args) => {
				const pair = args as { filePath: string };
				if (cmd === "list_compare_files") {
					lists += 1;
					const files = [makeFileDiff("f.ts"), makeFileDiff("g.ts")];
					if (lists === 1) return Promise.resolve(files);
					return new Promise<FileDiff[]>((resolve) => {
						release = () => resolve(files);
					});
				}
				if (cmd === "diff_compare_file")
					return Promise.resolve([
						makeFileDiffWithContent(pair.filePath, `DIFF OF ${pair.filePath}`),
					]);
				return base(cmd, args);
			});
			await fireEvent.click(rows[0], { metaKey: true });
			await fireEvent.click(await screen.findByText("f.ts"));
			expect(await screen.findByText("DIFF OF f.ts")).toBeTruthy();
			await fireEvent.click(
				await screen.findByLabelText("Swap comparison direction"),
			);
			await vi.waitFor(() => expect(lists).toBe(2));

			await fireEvent.click(await screen.findByText("g.ts"));
			release();

			expect(await screen.findByText("DIFF OF g.ts")).toBeTruthy();
			await flush();
			expect(screen.queryByText("DIFF OF f.ts")).toBeFalsy();
		});

		it("closes a file picked while a new pair loads when that pair lacks it", async () => {
			render(RepoView, {
				props: {
					...baseProps(createMockRemoteState()),
					contentMode: "hunk" as const,
					oncontentmodechange: vi.fn(),
				},
			});
			const rows = await screen.findAllByTestId("commit-row");
			await fireEvent.click(rows[2]);
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			const newPairFiles = Promise.withResolvers<FileDiff[]>();
			let lists = 0;
			mockInvoke.mockImplementation((cmd, args) => {
				const pair = args as { filePath: string };
				if (cmd === "list_compare_files") {
					lists += 1;
					if (lists === 1)
						return Promise.resolve([
							makeFileDiff("f.ts"),
							makeFileDiff("g.ts"),
						]);
					return newPairFiles.promise;
				}
				if (cmd === "diff_compare_file") {
					if (lists > 1 && pair.filePath === "g.ts") return Promise.resolve([]);
					return Promise.resolve([
						makeFileDiffWithContent(pair.filePath, `DIFF OF ${pair.filePath}`),
					]);
				}
				return base(cmd, args);
			});
			await fireEvent.click(rows[0], { metaKey: true });
			await screen.findByText("g.ts");
			await fireEvent.click(rows[1], { metaKey: true });
			await vi.waitFor(() => expect(lists).toBe(2));

			await fireEvent.click(screen.getByText("g.ts"));
			await screen.findByRole("button", { name: "Close diff" });

			newPairFiles.resolve([makeFileDiff("f.ts")]);

			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull(),
			);
			expect(screen.queryByText("g.ts")).toBeNull();
		});

		it("escape clears the compare", async () => {
			const rows = await renderAndGetRows();
			await fireEvent.click(rows[2]);
			await flush();
			await fireEvent.click(rows[0], { metaKey: true });
			await flush();
			expect(await screen.findByTestId("compare-header")).toBeTruthy();

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
			expect(await screen.findByTestId("compare-header")).toBeTruthy();

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
			render(RepoView, { props: baseProps(createMockRemoteState()) });
			// The WIP row and the three commit rows resolve from independent fetches
			// (get_dirty_counts vs. get_commit_graph); wait for all four rather than
			// the first row findAllByTestId happens to see.
			const rows = await vi.waitFor(() => {
				const found = screen.getAllByTestId("commit-row");
				if (found.length < 4) throw new Error("not all rows painted yet");
				return found;
			});
			await flush();
			// rows[0] is the WIP row; commits shift down one.
			await fireEvent.click(rows[3]); // oid-1
			await flush();
			await fireEvent.click(rows[1], { metaKey: true }); // oid-3
			await flush();
			expect(await screen.findByTestId("compare-header")).toBeTruthy();

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
							aSessionCommit({
								oid: "oid-2",
								short_oid: "oid-2",
								summary: "second commit",
							}),
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
			expect(await screen.findByTestId("compare-header")).toBeTruthy();

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

			await screen.findByLabelText("Close diff");
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
			// The file diff covers the graph in the center pane.
			expect(graphIsCovered()).toBe(true);

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(graphIsCovered()).toBe(true);
			expect(await screen.findByTestId("compare-header")).toBeTruthy();
		});

		it("the comment badge empties while a compare is open", async () => {
			const withCompare = mockInvoke.getMockImplementation();
			if (!withCompare)
				throw new Error("compare invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_active_review"
					? Promise.resolve("r1")
					: cmd === "list_threads"
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

	describe("escape inside an overlay (TRUNK-195)", () => {
		function makeFileDiff(path: string): FileDiff {
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
								content: "FILE BEHIND THE FINDER",
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			};
		}

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		beforeEach(() => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "list_tracked_files":
						return Promise.resolve([{ path: "src/alpha.ts", changed: false }]);
					case "open_current_file":
						return Promise.resolve([makeFileDiff("src/alpha.ts")]);
					case "get_active_review":
						return Promise.resolve("r1");
					default:
						return base(cmd, args);
				}
			});
		});

		it("escape in the file finder keeps the file the finder was opened over", async () => {
			const props = {
				...baseProps(createMockRemoteState()),
				reviewActive: true,
			};
			const { rerender } = render(RepoView, { props });
			await flush();
			await fireEvent.click(await screen.findByText(/Comment on a file/));
			await flush();
			await fireEvent.click(await findFinderOption());
			await flush();
			expect(await screen.findByText("FILE BEHIND THE FINDER")).toBeTruthy();
			fireReviewShowPanel();
			await flush();
			await fireEvent.click(await screen.findByText(/Comment on a file/));
			await flush();
			expect(screen.queryByRole("dialog")).toBeTruthy();

			await fireEvent.keyDown(
				screen.getByLabelText("Find a tracked file to comment on"),
				{ key: "Escape" },
			);
			await flush();
			expect(screen.queryByRole("dialog")).toBeNull();

			// Leaving review mode hands the centre pane back to the diff, which is
			// where the file the finder was opened over becomes visible again.
			await rerender({ ...props, reviewActive: false });

			await vi.dynamicImportSettled();
			await tick();

			expect(screen.getByText("FILE BEHIND THE FINDER")).toBeVisible();
		});

		it("escape with no overlay up still closes the file", async () => {
			render(RepoView, {
				props: { ...baseProps(createMockRemoteState()), reviewActive: true },
			});
			await flush();
			await fireEvent.click(await screen.findByText(/Comment on a file/));
			await flush();
			await fireEvent.click(await findFinderOption());
			await flush();
			expect(await screen.findByText("FILE BEHIND THE FINDER")).toBeTruthy();

			await fireEvent.keyDown(window, { key: "Escape" });
			await flush();

			expect(screen.queryByText("FILE BEHIND THE FINDER")).toBeNull();
		});
	});

	// The content mode is one App-owned value, so another tab can change it while
	// this one shows a current-file view; the view's own toolbar offers no toggle.
	describe("a current-file view opened over a staging file", () => {
		const MODE_BOUND_DIFF_COMMANDS = new Set([
			"diff_unstaged",
			"diff_staged",
			"diff_commit_file",
			"diff_compare_file",
		]);

		function oneLineFile(
			path: string,
			origin: "Add" | "Context",
			content: string,
		): FileDiff {
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
								origin,
								content,
								old_lineno: origin === "Add" ? null : 1,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			};
		}

		async function flush() {
			await new Promise((r) => setTimeout(r, 0));
		}

		function modeBoundDiffRequests(): number {
			return mockInvoke.mock.calls.filter(([cmd]) =>
				MODE_BOUND_DIFF_COMMANDS.has(cmd),
			).length;
		}

		beforeEach(() => {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			mockInvoke.mockImplementation((cmd, args) => {
				switch (cmd) {
					case "get_status":
						return Promise.resolve({
							unstaged: [
								{ path: "src/edited.ts", status: "Modified", is_binary: false },
								{ path: "src/other.ts", status: "Modified", is_binary: false },
							],
							staged: [],
							conflicted: [],
						});
					case "diff_unstaged":
						return Promise.resolve([
							oneLineFile("src/edited.ts", "Add", "let count = 1;"),
						]);
					case "list_tracked_files":
						return Promise.resolve([
							{ path: "src/untouched.ts", changed: false },
						]);
					case "open_current_file":
						return Promise.resolve([
							oneLineFile("src/untouched.ts", "Context", "const answer = 42;"),
						]);
					case "get_active_review":
						return Promise.resolve("r1");
					default:
						return base(cmd, args);
				}
			});
		});

		// Opens the staging file, then the tracked file over it. A rerender re-sends
		// every prop, and re-sending reviewActive puts the review panel back over the
		// view, so the view is left showing outside review mode.
		async function showTrackedFileOverStagingFile(contentMode: ContentMode) {
			const props = {
				...baseProps(createMockRemoteState()),
				reviewActive: true,
				contentMode,
				oncontentmodechange: vi.fn(),
			};
			const view = render(RepoView, { props });
			await fireEvent.click(await screen.findByText("src/edited.ts"));
			expect(await screen.findByText("let count = 1;")).toBeTruthy();
			fireReviewShowPanel();
			await flush();
			await fireEvent.click(await screen.findByText(/Comment on a file/));
			await flush();
			await fireEvent.click(await findFinderOption());
			await flush();
			const outsideReview = { ...props, reviewActive: false };
			await view.rerender(outsideReview);
			await vi.dynamicImportSettled();
			await tick();

			expect(screen.getByText("const answer = 42;")).toBeVisible();

			return {
				changeContentMode: async (mode: ContentMode) => {
					await view.rerender({ ...outsideReview, contentMode: mode });
					await flush();
				},
			};
		}

		it("keeps the full-file view without requesting a diff when the content mode changes", async () => {
			const { changeContentMode } =
				await showTrackedFileOverStagingFile("full");
			const requestsBefore = modeBoundDiffRequests();

			await changeContentMode("hunk");

			expect(document.querySelector(".full-file")).not.toBeNull();
			expect(modeBoundDiffRequests()).toBe(requestsBefore);
		});

		// Every later staging diff request stays pending, so the test sees what the
		// pane shows while it waits.
		function holdStagingDiffRequests(): () => boolean {
			const base = mockInvoke.getMockImplementation();
			if (!base) throw new Error("base invoke implementation missing");
			let held = false;
			mockInvoke.mockImplementation((cmd, args) => {
				if (cmd !== "diff_unstaged") return base(cmd, args);
				held = true;
				return new Promise<FileDiff[]>(() => {});
			});
			return () => held;
		}

		it("withholds the old mode's staging hunks after leaving the view", async () => {
			const { changeContentMode } =
				await showTrackedFileOverStagingFile("hunk");
			await changeContentMode("full");
			const requestHeld = holdStagingDiffRequests();

			await fireEvent.click(screen.getByText("src/edited.ts"));
			await vi.waitFor(() => expect(requestHeld()).toBe(true));

			expect(await screen.findByText("Loading diff…")).toBeTruthy();
			expect(screen.queryByText("let count = 1;")).toBeNull();
		});

		it("withholds the earlier staging file's hunks while the next one loads", async () => {
			await showTrackedFileOverStagingFile("hunk");
			const requestHeld = holdStagingDiffRequests();

			await fireEvent.click(screen.getByText("src/other.ts"));
			await vi.waitFor(() => expect(requestHeld()).toBe(true));

			expect(await screen.findByText("Loading diff…")).toBeTruthy();
			expect(screen.queryByText("let count = 1;")).toBeNull();
		});
	});
});

async function findFinderOption(): Promise<HTMLElement> {
	const finder = await screen.findByRole("listbox", { name: "Tracked files" });

	return within(finder).findByRole("option");
}
