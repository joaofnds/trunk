import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import {
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
import {
	conflictRegion,
	gitMergedRegion,
	mergedRegion,
} from "../__tests__/helpers/factories.js";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import { noReviewCounts } from "../__tests__/helpers/review-props.js";
import { safeInvoke } from "../lib/invoke.js";
import { createMergePicks } from "../lib/merge-picks.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import type { MergeSides, ReviewTally } from "../lib/types.js";
import StagingPanel from "./StagingPanel.svelte";

// All Tauri module mocks — declared locally for proper vi.mock hoisting.
// Patched at the wrapper the components call, not at @tauri-apps/api/core
// beneath it, so a test states the call the component makes rather than the
// transport under it. safeInvoke itself is replaced here, so its error
// translation does not run in this file; invoke.test.ts owns that.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return { ...actual, safeInvoke: vi.fn() };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

const eventHandlers = vi.hoisted(
	() => new Map<string, (event: { payload: unknown }) => void>(),
);
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(
		(name: string, callback: (event: { payload: unknown }) => void) => {
			eventHandlers.set(name, callback);
			return Promise.resolve(() => eventHandlers.delete(name));
		},
	),
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

const mockInvoke = vi.mocked(safeInvoke);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function stagingRowFor(element: Element): HTMLElement {
	const row = element.closest<HTMLElement>('[data-testid="staging-file"]');
	if (!row) throw new Error("expected content inside a staging file row");
	return row;
}

// A busy row draws no button of its own, so a click on it cannot race the
// operation that moves it.
function rowAction(path: string, name: string): HTMLElement | null {
	const row = stagingRowFor(screen.getByTitle(path));
	return within(row.parentElement ?? document.body).queryByRole("button", {
		name,
	});
}

function folderAction(folder: RegExp): HTMLElement | null {
	const row = screen.getByRole("treeitem", { name: folder });
	return within(row.parentElement ?? document.body).queryByRole("button", {
		name: "Stage directory",
	});
}

async function callsOnceRefreshed(commandPrefix: string) {
	const matching = (command: string) => command.startsWith(commandPrefix);
	await waitFor(() => {
		const commands = mockInvoke.mock.calls.map(([command]) => command);
		const first = commands.findIndex(matching);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(commands.slice(first)).toContain("get_status");
	});
	return mockInvoke.mock.calls.filter(([command]) => matching(command));
}

async function chooseFolderMenuItem(folder: RegExp, text: RegExp) {
	const row = await screen.findByRole("treeitem", { name: folder });
	vi.mocked(MenuItem.new).mockClear();
	await fireEvent.contextMenu(row);
	const item = await waitFor(() => {
		const found = vi
			.mocked(MenuItem.new)
			.mock.calls.map(([options]) => options)
			.find((options) => text.test(options.text));
		expect(found?.action).toBeDefined();
		return found;
	});
	item?.action?.(item.text);
}

// The file lists build only the rows in view, and jsdom lays nothing out, so
// every list is given a viewport tall enough to hold all of its rows.
beforeEach(() => stubLayout({ width: 300, height: 4000 }));
afterEach(restoreLayout);
describe("StagingPanel", () => {
	beforeEach(() => {
		eventHandlers.clear();
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({
					unstaged: [
						{ path: "README.md", status: "Modified", is_binary: false },
					],
					staged: [{ path: "src/main.ts", status: "New", is_binary: false }],
					conflicted: [],
				});
			if (cmd === "get_operation_state")
				return Promise.resolve({
					op_type: "None",
					source_branch: null,
					target_branch: null,
					onto_oid: null,
					progress: null,
					rebase_message: null,
					commit: null,
				});
			return Promise.resolve(undefined);
		});
	});

	it("keeps directory expansion and list view available in a narrow tree header", async () => {
		stubLayout({ width: 200, height: 700, replace: true });
		const props = {
			repoPath: "/repo",
			treeViewEnabled: true,
			ontreeviewtoggle: vi.fn(),
			...noReviewCounts(),
		};
		const { rerender } = render(StagingPanel, { props });

		await screen.findByRole("treeitem", { name: /^src/ });
		const bulk = screen.getByRole("button", {
			name: "Expand all directories",
		});
		const mode = screen.getByRole("switch", { name: "Switch to list view" });
		bulk.focus();
		await fireEvent.click(bulk);
		expect(screen.getByTitle("src/main.ts")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Collapse all directories" }),
		).toBe(bulk);
		expect(bulk).toHaveFocus();

		await fireEvent.click(bulk);
		expect(screen.queryByTitle("src/main.ts")).toBeNull();
		expect(bulk).toHaveAccessibleName("Expand all directories");

		await fireEvent.click(mode);
		expect(props.ontreeviewtoggle).toHaveBeenCalledOnce();
		await rerender({ treeViewEnabled: false });
		expect(screen.getByRole("switch", { name: "Switch to tree view" })).toBe(
			mode,
		);
		expect(bulk).not.toBeInTheDocument();
		expect(screen.getByTitle("src/main.ts")).toBeVisible();

		const staged = screen.getByRole("button", { name: /^Staged files/ });
		await fireEvent.click(staged);
		await rerender({ treeViewEnabled: true });
		expect(screen.queryByTitle("src/main.ts")).toBeNull();
		await fireEvent.click(staged);
		expect(screen.getByTitle("src/main.ts")).toBeVisible();

		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse all directories" }),
		);
		await fireEvent.click(staged);
		await fireEvent.click(staged);
		expect(screen.queryByTitle("src/main.ts")).toBeNull();
	});

	it("applies one action across open staging sections and skips a closed section", async () => {
		mockInvoke.mockImplementation(async (command) => {
			if (command === "get_status")
				return {
					unstaged: [
						{ path: "src/main.ts", status: "Modified", is_binary: false },
						{ path: "src/deep/one.ts", status: "Modified", is_binary: false },
					],
					staged: [{ path: "docs/guide.md", status: "New", is_binary: false }],
					conflicted: [
						{ path: "lib/merge.ts", status: "Conflicted", is_binary: false },
					],
				};
		});
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo", treeViewEnabled: true },
		});

		await fireEvent.click(
			await screen.findByRole("treeitem", { name: /^src / }),
		);
		const staged = screen.getByRole("button", { name: /^Staged files/ });
		await fireEvent.click(staged);
		await fireEvent.click(
			screen.getByRole("button", { name: "Expand all directories" }),
		);

		expect(screen.getByTitle("src/main.ts")).toBeVisible();
		expect(screen.getByTitle("src/deep/one.ts")).toBeVisible();
		expect(screen.getByTitle("lib/merge.ts")).toBeVisible();
		expect(screen.queryByRole("treeitem", { name: /^docs / })).toBeNull();
		const collapse = screen.getByRole("button", {
			name: "Collapse all directories",
		});

		await fireEvent.click(staged);
		expect(screen.getByRole("treeitem", { name: /^docs / })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(collapse).toHaveAccessibleName("Expand all directories");

		await fireEvent.click(collapse);
		expect(screen.getByTitle("docs/guide.md")).toBeVisible();
		await fireEvent.click(collapse);
		for (const path of [
			"src/main.ts",
			"src/deep/one.ts",
			"lib/merge.ts",
			"docs/guide.md",
		]) {
			expect(screen.queryByTitle(path)).toBeNull();
		}
	});

	it("renders without crashing", () => {
		const { container } = render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/test/repo",
			},
		});
		expect(container).toBeTruthy();
	});

	it("paints the bulk actions in the tone each carries", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Stage all changes" }),
			).toHaveClass("bg-success-bg");
		});
		expect(
			screen.getByRole("button", { name: "Discard all changes" }),
		).toHaveClass("bg-danger-bg");
		expect(screen.getByRole("button", { name: "Unstage all" })).toHaveClass(
			"bg-warning-bg",
		);
	});

	it("says a bare repository has no working tree, in place of the commit form", async () => {
		_resetToasts();
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "get_status"
				? Promise.reject({
						code: "git_bare_repo",
						message:
							"cannot status. This operation is not allowed against bare repositories.",
					})
				: Promise.resolve(undefined),
		);
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});

		expect(
			await screen.findByText(
				"This is a bare repository. It has no working tree, so there are no changes to stage or commit.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
		expect(toasts.items).toEqual([]);
	});

	it("draws the view switch as a small icon control", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});

		await waitFor(() => {
			expect(screen.getByRole("switch")).toHaveClass("w-control-sm");
		});
	});

	it("renders file count header", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/test/repo",
			},
		});
		// Header shows "{totalCount} file(s) changed" — 1 unstaged + 1 staged = 2
		await waitFor(() => {
			expect(screen.getByText("2 files changed")).toBeInTheDocument();
		});
	});

	it("sizes the panel header from the shared panel-header height", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/test/repo",
			},
		});

		const header = (await screen.findByText("2 files changed")).closest(
			"div.h-bar",
		);

		expect(header).toHaveClass("h-bar");
	});

	it("counts each section's files in a muted badge set apart from the label's tracking", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({
					unstaged: [
						{ path: "README.md", status: "Modified", is_binary: false },
						{ path: "LICENSE", status: "Modified", is_binary: false },
					],
					staged: [{ path: "src/main.ts", status: "New", is_binary: false }],
					conflicted: [],
				});
			if (cmd === "get_operation_state")
				return Promise.resolve({ op_type: "None" });
			return Promise.resolve(undefined);
		});
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});

		const unstaged = await screen.findByTestId("staging-unstaged-section");
		const staged = screen.getByTestId("staging-staged-section");

		const unstagedCount = await within(unstaged).findByText("2");
		expect(within(staged).getByText("1")).toHaveClass("text-text-muted");
		expect(unstagedCount).toHaveClass("bg-surface-chip", "text-text-muted");
		expect(unstagedCount.closest(".tracking-widest")).toBeNull();
	});

	it("stages a byte-named file without targeting the identical displayed filename", async () => {
		const bytes = [110, 45, 255];
		const text = { path: String.raw`n-\xff`, status: "New", is_binary: false };
		const raw = { ...text, path_bytes: bytes };
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "get_status")
				return { unstaged: [text, raw], staged: [], conflicted: [] };
			if (cmd === "get_operation_state") return { op_type: "None" };
		});
		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });
		const row = stagingRowFor(await screen.findByText("Byte escapes"));
		await fireEvent.mouseEnter(row);
		await fireEvent.click(
			within(row.parentElement ?? document.body).getByLabelText("Stage file"),
		);
		expect(mockInvoke).toHaveBeenCalledWith("stage_file", {
			path: "/repo",
			filePath: bytes,
		});
		await fireEvent.click(
			await screen.findByRole("button", { name: "Filter files" }),
		);
		await fireEvent.input(
			screen.getByRole("textbox", { name: "Filter files" }),
			{ target: { value: "n-" } },
		);
		await fireEvent.click(
			await screen.findByRole("button", { name: "Stage 2 matches" }),
		);
		expect(mockInvoke).toHaveBeenCalledWith("stage_files", {
			path: "/repo",
			filePaths: [text.path, bytes],
		});
	});

	it("stages a byte-named directory independently of its UTF-8 lookalike", async () => {
		const bytes = [255, 47, 97];
		const text = { path: String.raw`\xff/a`, status: "New", is_binary: false };
		const raw = { ...text, path_bytes: bytes };
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "get_status")
				return { unstaged: [text, raw], staged: [], conflicted: [] };
			if (cmd === "get_operation_state") return { op_type: "None" };
		});
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo", treeViewEnabled: true },
		});
		const folder = await screen.findByRole("treeitem", {
			name: /Byte escapes/,
		});
		await fireEvent.mouseEnter(folder);
		await fireEvent.click(
			within(folder.parentElement ?? document.body).getByLabelText(
				"Stage directory",
			),
		);
		expect(mockInvoke).toHaveBeenCalledWith("stage_files", {
			path: "/repo",
			filePaths: [bytes],
		});
	});

	it("stages only matching files while the commit names the whole index", async () => {
		const hidden = {
			path: "docs/note.md",
			status: "Modified",
			is_binary: false,
		};
		const hit = { ...hidden, path: "src/item.ts" };
		let staged = false;
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "get_status")
				return {
					unstaged: staged ? [hidden] : [hit, hidden],
					staged: staged ? [hidden, hit] : [hidden],
					conflicted: [],
				};
			if (cmd === "get_operation_state") return { op_type: "None" };
			if (cmd === "stage_files") staged = true;
		});
		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });
		await fireEvent.click(
			await screen.findByRole("button", { name: "Filter files" }),
		);
		const input = screen.getByRole("textbox", { name: "Filter files" });
		await fireEvent.input(input, { target: { value: "src/" } });
		expect(screen.queryByTitle("docs/note.md")).toBeNull();
		await fireEvent.click(
			screen.getByRole("button", { name: "Stage 1 match" }),
		);
		expect(await callsOnceRefreshed("stage_")).toEqual([
			["stage_files", { path: "/repo", filePaths: ["src/item.ts"] }],
		]);
		expect(input).toHaveValue("src/");
		expect(
			await screen.findByRole("button", { name: "Commit 2 staged files" }),
		).toBeVisible();
		expect(
			within(screen.getByTestId("staging-staged-section")).getByText("1 of 2"),
		).toBeVisible();
	});

	it("folds a section's files away when its header is clicked", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});
		const header = await screen.findByRole("button", {
			name: /Unstaged files/,
		});
		expect(await screen.findAllByTestId("staging-file")).toHaveLength(2);

		await fireEvent.click(header);

		expect(screen.queryByText("README.md")).not.toBeInTheDocument();
		expect(screen.getAllByTestId("staging-file")).toHaveLength(1);
	});

	it.each(["Stage all changes", "Discard all changes", "Unstage all"])(
		"keeps both sections open when %s is clicked",
		async (action) => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/test/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: action }),
			);

			expect(screen.getAllByTestId("staging-file")).toHaveLength(2);
		},
	);

	it.each([
		["Stage all changes", "stage_all", "README.md", "Stage file"],
		["Unstage all", "unstage_all", "src/main.ts", "Unstage file"],
		["Discard all changes", "discard_all", "README.md", "Stage file"],
	])(
		"holds the files %s moves busy until it finishes",
		async (button, command, path, action) => {
			const finished = deferred<undefined>();
			const answer = mockInvoke.getMockImplementation();
			if (!answer) throw new Error("the panel's reads have no stub");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === command ? finished.promise : answer(cmd, args),
			);
			vi.mocked(ask).mockResolvedValue(true);
			onTestFinished(() => {
				vi.mocked(ask).mockResolvedValue(false);
			});
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/test/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: button }),
			);
			await waitFor(() =>
				expect(mockInvoke).toHaveBeenCalledWith(command, expect.anything()),
			);
			const whileRunning = rowAction(path, action);
			finished.resolve(undefined);

			expect(whileRunning).toBeNull();
			await waitFor(() => expect(rowAction(path, action)).not.toBeNull());
		},
	);

	it("names one discarded file in the singular", async () => {
		_resetToasts();
		vi.mocked(ask).mockResolvedValueOnce(true);
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: "Discard all changes" }),
		);

		await waitFor(() =>
			expect(toasts.items.map((toast) => toast.message)).toEqual([
				"Discarded all changes (1 file)",
			]),
		);
	});

	it("renders current branch name when provided", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/test/repo",
				currentBranch: "feature/test",
			},
		});
		await waitFor(() => {
			expect(screen.getByText("feature/test")).toBeInTheDocument();
		});
	});

	it("copies the current branch when its chip is pressed", async () => {
		vi.mocked(writeText).mockClear();
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/test/repo",
				currentBranch: "feature/test",
			},
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: "feature/test" }),
		);

		expect(vi.mocked(writeText)).toHaveBeenCalledWith("feature/test");
	});

	it("routes filtered snapshot badges and tones to both staging sections", async () => {
		const workingTree = "working-tree-snapshot";
		const index = "index-snapshot";
		const reviewComments = createFakeReviewComments();
		reviewComments.seed({
			threads: [],
			snapshots: {
				working_tree_snapshot: workingTree,
				index_snapshot: index,
			},
		});
		await reviewComments.refresh();

		render(StagingPanel, {
			props: {
				repoPath: "/test/repo",
				reviewComments,
				commentCounts: new Map([
					[`${workingTree}\0README.md`, 2],
					[`${index}\0src/main.ts`, 1],
				]),
				commentTallies: new Map<string, ReviewTally>([
					[`${workingTree}\0README.md`, { addressed: 2 }],
					[`${index}\0src/main.ts`, { done: 1 }],
				]),
			},
		});

		await screen.findByText("README.md");
		const unstaged = screen.getByTestId("staging-unstaged-section");
		const staged = screen.getByTestId("staging-staged-section");
		expect(unstaged.querySelector(".comment-badge")).toHaveTextContent("2");
		expect(unstaged.querySelector(".comment-badge-pill")).toHaveClass(
			"tone-addressed",
		);
		expect(staged.querySelector(".comment-badge")).toHaveTextContent("1");
		expect(staged.querySelector(".comment-badge-pill")).toHaveClass(
			"tone-done",
		);
	});

	it("calls get_status on mount with repo path", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/my/repo",
			},
		});
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("get_status", {
				path: "/my/repo",
			});
		});
	});

	it("keeps a staging action pending for a post-action status read", async () => {
		const scheduler = new FakeScheduler();
		const beforeAction = {
			unstaged: [{ path: "README.md", status: "Modified", is_binary: false }],
			staged: [],
			conflicted: [],
		};
		const afterAction = {
			unstaged: [],
			staged: [{ path: "README.md", status: "Modified", is_binary: false }],
			conflicted: [],
		};
		const held = deferred<typeof beforeAction>();
		const caughtUp = deferred<typeof afterAction>();
		let statusReads = 0;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status") {
				statusReads += 1;
				if (statusReads === 1) return Promise.resolve(beforeAction);
				if (statusReads === 2) return held.promise;
				return caughtUp.promise;
			}
			if (cmd === "get_operation_state") {
				return Promise.resolve({ op_type: "None" });
			}
			return Promise.resolve(undefined);
		});

		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
			context: new Map([[SCHEDULER, scheduler]]),
		});
		const row = await screen.findByText("README.md");
		eventHandlers.get("repo-changed")?.({
			payload: { repo: "/test/repo", paths: [] },
		});
		scheduler.advanceBy(200);
		await tick();
		expect(statusReads).toBe(2);

		await fireEvent.mouseEnter(stagingRowFor(row));
		await fireEvent.click(screen.getByLabelText("Stage file"));
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("stage_file", {
				path: "/test/repo",
				filePath: "README.md",
			});
		});

		held.resolve(beforeAction);
		await waitFor(() => expect(statusReads).toBe(3));
		expect(screen.queryByLabelText("Stage file")).toBeNull();

		caughtUp.resolve(afterAction);
		await waitFor(() => {
			expect(screen.getByText("README.md")).toBeInTheDocument();
		});
		await fireEvent.mouseEnter(stagingRowFor(screen.getByText("README.md")));
		expect(await screen.findByLabelText("Unstage file")).toBeInTheDocument();
	});

	it("keeps a staged row when a read started before the stage answers late", async () => {
		const scheduler = new FakeScheduler();
		const beforeAction = {
			unstaged: [{ path: "README.md", status: "Modified", is_binary: false }],
			staged: [],
			conflicted: [],
		};
		const held = deferred<typeof beforeAction>();
		const caughtUp = deferred<typeof beforeAction>();
		let statusReads = 0;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status") {
				statusReads += 1;
				if (statusReads === 1) return Promise.resolve(beforeAction);
				if (statusReads === 2) return held.promise;
				return caughtUp.promise;
			}
			if (cmd === "get_operation_state") {
				return Promise.resolve({ op_type: "None" });
			}
			return Promise.resolve(undefined);
		});
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
			context: new Map([[SCHEDULER, scheduler]]),
		});
		const row = await screen.findByText("README.md");
		eventHandlers.get("repo-changed")?.({
			payload: { repo: "/test/repo", paths: [] },
		});
		scheduler.advanceBy(200);
		await tick();
		expect(statusReads).toBe(2);
		await fireEvent.mouseEnter(stagingRowFor(row));
		await fireEvent.click(screen.getByLabelText("Stage file"));
		const staged = screen.getByTestId("staging-staged-section");
		await waitFor(() =>
			expect(within(staged).getByText("README.md")).toBeInTheDocument(),
		);

		held.resolve(beforeAction);
		await waitFor(() => expect(statusReads).toBe(3));

		expect(within(staged).getByText("README.md")).toBeInTheDocument();
	});

	it("reports a failed stage and gives the file its stage action back", async () => {
		_resetToasts();
		const answer = mockInvoke.getMockImplementation();
		if (answer === undefined) throw new Error("status is not mocked");
		mockInvoke.mockImplementation(
			(command: string, args?: Record<string, unknown>) =>
				command === "stage_file"
					? Promise.reject({
							code: "git_locked",
							message: "the index is locked",
						})
					: answer(command, args),
		);
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});
		await fireEvent.mouseEnter(
			stagingRowFor(await screen.findByText("README.md")),
		);

		await fireEvent.click(screen.getByLabelText("Stage file"));

		await waitFor(() => {
			expect(toasts.items).toEqual([
				{
					id: expect.any(Number),
					message: "the index is locked",
					kind: "error",
				},
			]);
		});
		await callsOnceRefreshed("stage_file");
		await fireEvent.mouseEnter(stagingRowFor(screen.getByText("README.md")));
		expect(screen.getByLabelText("Stage file")).toBeInTheDocument();
	});
});

describe("StagingPanel merge-continue", () => {
	function resolutions(...paths: string[]) {
		return paths.map((path) => ({ path, revision: `revision of ${path}` }));
	}

	function mockMergeState(
		conflicted: unknown[] = [],
		unstaged: unknown[] = [],
		withMarkers: string[] = [],
	) {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string, args = {}) => {
			if (cmd === "prepare_mark_resolved")
				return Promise.resolve({
					files: resolutions(...(args.filePaths as string[])),
					marked: withMarkers,
				});
			if (cmd === "get_status")
				return Promise.resolve({
					unstaged,
					staged: [{ path: "src/main.ts", status: "New", is_binary: false }],
					conflicted,
				});
			if (cmd === "get_operation_state")
				return Promise.resolve({
					op_type: "Merge",
					source_branch: "feature",
					target_branch: "main",
					onto_oid: null,
					progress: null,
					rebase_message: null,
					commit: null,
				});
			if (cmd === "get_merge_message")
				return Promise.resolve("Merge branch 'feature'");
			return Promise.resolve(undefined);
		});
	}

	beforeEach(() => {
		mockMergeState();
	});

	it("routes merge-commit through get_merge_message then the editor then merge_continue", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue("edited message");
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});

		const button = await screen.findByText("Commit merge");
		await fireEvent.click(button);

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("get_merge_message", {
				path: "/repo",
			});
		});
		expect(onopenmessageeditor).toHaveBeenCalledWith(
			"Merge branch 'feature'",
			"Merge commit message",
		);
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("merge_continue", {
				path: "/repo",
				message: "edited message",
			});
		});
	});

	it("makes no merge_continue commit when the editor is cancelled", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue(null);
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});

		const button = await screen.findByText("Commit merge");
		await fireEvent.click(button);

		await waitFor(() => {
			expect(onopenmessageeditor).toHaveBeenCalled();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"merge_continue",
			expect.anything(),
		);
	});

	it("does not render the old inline subject/body merge form", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
			},
		});
		await screen.findByText("Commit merge");
		expect(screen.queryByPlaceholderText("Merge commit message")).toBeNull();
		expect(screen.queryByText("Commit and Merge")).toBeNull();
	});

	it("still renders the Abort Merge recovery button in merge state", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
			},
		});
		expect(await screen.findByText("Abort Merge")).toBeInTheDocument();
	});

	it("identifies marking conflicts resolved in a narrow pane", async () => {
		stubLayout({ width: 200, height: 700, replace: true });
		mockMergeState([
			{
				path: "src/a.ts",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
		]);
		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });

		expect(
			await screen.findByRole("button", { name: "Mark All Resolved" }),
		).toBeVisible();
		expect(screen.getByText("1 conflict")).toBeVisible();
	});

	it("hides an empty unstaged list beside a merge's conflicts", async () => {
		mockMergeState([
			{
				path: "src/a.ts",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
		]);

		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });

		await screen.findByRole("button", { name: "Mark All Resolved" });
		expect(screen.queryByTestId("staging-unstaged-section")).toBeNull();
	});

	it("moves a staged conflict into the staged list before the status answers", async () => {
		mockMergeState([
			{
				path: "src/a.ts",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
		]);
		const answer = mockInvoke.getMockImplementation();
		if (answer === undefined) throw new Error("merge state is not mocked");
		const held = deferred<unknown>();
		let refreshes = 0;
		mockInvoke.mockImplementation(
			(command: string, args?: Record<string, unknown>) => {
				if (command === "get_status" && refreshes++ > 0) return held.promise;
				return answer(command, args);
			},
		);
		const onstatuschange = vi.fn();
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo", onstatuschange },
		});
		const row = stagingRowFor(await screen.findByTitle("src/a.ts"));
		const rowWithActions = row.parentElement;
		if (rowWithActions === null) throw new Error("file row is detached");

		await fireEvent.click(
			within(rowWithActions).getByRole("button", { name: "Stage file" }),
		);

		await waitFor(() =>
			expect(onstatuschange).toHaveBeenLastCalledWith(
				expect.objectContaining({
					conflicted: [],
					staged: expect.arrayContaining([
						expect.objectContaining({ path: "src/a.ts" }),
					]),
				}),
			),
		);
	});

	describe("when a conflicted file still holds conflict markers", () => {
		const conflict = {
			path: "src/a.ts",
			status: "Conflicted",
			is_binary: false,
		};

		beforeEach(() => {
			mockMergeState([conflict], [], ["src/a.ts"]);
			vi.mocked(ask).mockReset().mockResolvedValue(false);
		});

		function stageCalls() {
			return mockInvoke.mock.calls.filter(
				([command]) =>
					command.startsWith("stage_file") ||
					command === "mark_conflicts_resolved",
			);
		}

		it("asks before Mark All Resolved stages it, naming the file", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);

			await waitFor(() =>
				expect(ask).toHaveBeenCalledWith(
					expect.stringContaining("src/a.ts"),
					expect.objectContaining({
						okLabel: "Mark Resolved",
						cancelLabel: "Cancel",
					}),
				),
			);
			expect(stageCalls()).toEqual([]);
		});

		it("stages it once the user confirms", async () => {
			vi.mocked(ask).mockResolvedValueOnce(true);
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);

			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("src/a.ts") },
				],
			]);
		});

		it("keeps Output when the working file changes during the marker warning", async () => {
			const mergePicks = createMergePicks();
			mergePicks.set("/repo", "src/a.ts", "original", {
				taken: new Set(),
				typed: "keep my output",
			});
			const confirmation = deferred<boolean>();
			vi.mocked(ask)
				.mockResolvedValueOnce(true)
				.mockReturnValueOnce(confirmation.promise);
			const read = mockInvoke.getMockImplementation();
			if (!read) throw new Error("missing merge state");
			mockInvoke.mockImplementation((command, args) =>
				command === "mark_conflicts_resolved"
					? Promise.reject({
							code: "conflict_changed",
							message: "Working file changed",
						})
					: read(command, args),
			);
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo", mergePicks },
			});
			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);
			await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
			expect(mockInvoke).toHaveBeenCalledWith("prepare_mark_resolved", {
				path: "/repo",
				filePaths: ["src/a.ts"],
			});
			expect(stageCalls()).toEqual([]);
			confirmation.resolve(true);
			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("src/a.ts") },
				],
			]);
			expect(mergePicks.draftText("/repo", "src/a.ts")).toBe("keep my output");
			expect(
				toasts.items.some((toast) => toast.message === "Working file changed"),
			).toBe(true);
		});

		it("asks before the file's own action marks it resolved", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});
			const row = stagingRowFor(await screen.findByTitle("src/a.ts"));
			const rowWithActions = row.parentElement;
			if (rowWithActions === null) throw new Error("file row is detached");

			await fireEvent.click(
				within(rowWithActions).getByRole("button", { name: "Stage file" }),
			);

			await waitFor(() => expect(ask).toHaveBeenCalled());
			expect(stageCalls()).toEqual([]);
		});

		it("asks before a folder's Resolve All stages it", async () => {
			mockMergeState([{ ...conflict, path: "lib/a.ts" }], [], ["lib/a.ts"]);
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					treeViewEnabled: true,
				},
			});

			await chooseFolderMenuItem(/^lib \(1\)/, /^Resolve All/);

			await waitFor(() => expect(ask).toHaveBeenCalled());
			expect(stageCalls()).toEqual([]);
		});

		it("marks a file without markers resolved without asking", async () => {
			mockMergeState([conflict]);
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);

			await callsOnceRefreshed("mark_conflicts_resolved");
			expect(ask).not.toHaveBeenCalled();
		});
	});

	describe("when the merge leaves the user's own edits beside its conflicts", () => {
		const conflict = {
			path: "src/a.ts",
			status: "Conflicted",
			is_binary: false,
		};
		const ownEdit = { path: "notes.md", status: "Modified", is_binary: false };

		beforeEach(() => {
			mockMergeState([conflict], [ownEdit]);
		});

		it("lists the conflicts and the unstaged edits", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await screen.findByRole("button", { name: "Mark All Resolved" });

			expect(screen.getByTitle("src/a.ts")).toBeInTheDocument();
			expect(
				within(screen.getByTestId("staging-unstaged-section")).getByText(
					"notes.md",
				),
			).toBeInTheDocument();
		});

		it("moves on from the open conflict once it is marked resolved", async () => {
			const onfileadvance = vi.fn();
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					onfileadvance,
					selectedPath: "src/a.ts",
					selectedKind: "conflicted",
				},
			});

			await screen.findByRole("button", { name: "Mark All Resolved" });
			const row = stagingRowFor(screen.getByTitle("src/a.ts"));
			const rowWithActions = row.parentElement;
			if (rowWithActions === null) throw new Error("file row is detached");

			await fireEvent.click(
				within(rowWithActions).getByRole("button", { name: "Stage file" }),
			);

			await waitFor(() =>
				expect(onfileadvance).toHaveBeenCalledWith("src/a.ts", "conflicted"),
			);
		});
	});

	describe("when taking a whole side from a conflicted file's menu", () => {
		const sides: MergeSides = {
			revision: "snapshot",
			current_label: null,
			incoming_label: null,
			base_oid: null,
			regions: [
				mergedRegion("a"),
				conflictRegion(["B-ours"], ["B-theirs"]),
				gitMergedRegion({
					ours: ["c", "d-ours", "e", "f", ""],
					theirs: ["c", "d", "e", "f-theirs", ""],
					merged: ["c", "d-ours", "e", "f-theirs", ""],
				}),
			],
		};

		it("disables both text resolutions for a binary conflict", async () => {
			mockMergeState([
				{
					path: "asset",
					status: "Conflicted",
					is_binary: true,
					can_take_sides: false,
				},
			]);
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});
			const row = stagingRowFor(await screen.findByTitle("asset"));
			vi.mocked(MenuItem.new).mockClear();

			await fireEvent.contextMenu(row);

			for (const text of ["Take All Current", "Take All Incoming"]) {
				await waitFor(() =>
					expect(MenuItem.new).toHaveBeenCalledWith(
						expect.objectContaining({ text, enabled: false }),
					),
				);
			}
		});

		it("keeps edited Output when sidebar replacement is declined", async () => {
			const mergePicks = createMergePicks();
			mergePicks.set("/repo", "draft.ts", "snapshot", {
				taken: new Set(),
				typed: "my edit",
			});
			mockMergeState([
				{
					path: "draft.ts",
					status: "Conflicted",
					is_binary: false,
					can_take_sides: true,
				},
			]);
			const read = mockInvoke.getMockImplementation();
			if (!read) throw new Error("missing merge state");
			mockInvoke.mockImplementation((cmd, args) =>
				cmd === "get_merge_sides" ? Promise.resolve(sides) : read(cmd, args),
			);
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo", mergePicks },
			});
			vi.mocked(MenuItem.new).mockClear();
			vi.mocked(ask).mockResolvedValueOnce(false);
			await fireEvent.contextMenu(
				stagingRowFor(await screen.findByTitle("draft.ts")),
			);
			const action = await waitFor(() => {
				const item = vi
					.mocked(MenuItem.new)
					.mock.calls.find(([info]) => info.text === "Take All Incoming")?.[0];
				expect(item?.action).toBeDefined();
				return item?.action;
			});
			action?.("Take All Incoming");
			await waitFor(() =>
				expect(ask).toHaveBeenCalledWith(
					expect.stringContaining("draft.ts"),
					expect.objectContaining({ title: "Replace Edited Output" }),
				),
			);
			expect(mergePicks.get("/repo", "draft.ts")?.picks.typed).toBe("my edit");
			expect(mockInvoke.mock.calls.map(([command]) => command)).not.toContain(
				"save_merge_result",
			);
		});

		it.each([
			["Take All Current", "a\nB-ours\nc\nd-ours\ne\nf-theirs\n"],
			["Take All Incoming", "a\nB-theirs\nc\nd-ours\ne\nf-theirs\n"],
		])(
			"%s takes that side of the conflict and keeps the rest as git merged it",
			async (text, merged) => {
				mockMergeState([
					{
						path: "src/a.ts",
						status: "Conflicted",
						is_binary: false,
						can_take_sides: true,
					},
				]);
				const answer = mockInvoke.getMockImplementation();
				if (answer === undefined) throw new Error("merge state is not mocked");
				mockInvoke.mockImplementation(
					(command: string, args?: Record<string, unknown>) =>
						command === "get_merge_sides" && args?.purpose === "resolution"
							? Promise.resolve(sides)
							: answer(command, args),
				);
				render(StagingPanel, {
					props: { ...noReviewCounts(), repoPath: "/repo" },
				});
				const row = stagingRowFor(await screen.findByTitle("src/a.ts"));
				vi.mocked(MenuItem.new).mockClear();

				await fireEvent.contextMenu(row);
				const item = await waitFor(() => {
					const found = vi
						.mocked(MenuItem.new)
						.mock.calls.map(([options]) => options)
						.find((options) => options.text === text);
					expect(found?.action).toBeDefined();
					return found;
				});
				item?.action?.(text);

				await waitFor(() =>
					expect(mockInvoke).toHaveBeenCalledWith("save_merge_result", {
						expectedRevision: "snapshot",
						path: "/repo",
						filePath: "src/a.ts",
						content: merged,
					}),
				);
			},
		);

		async function takeIncomingWithSaveError(error: {
			code: string;
			message: string;
			working_revision?: string;
		}) {
			const path = "src/a.ts";
			const mergePicks = createMergePicks();
			mockMergeState([
				{ path, status: "Conflicted", is_binary: false, can_take_sides: true },
			]);
			const read = mockInvoke.getMockImplementation();
			if (!read) throw new Error("missing merge state");
			mockInvoke.mockImplementation((command, args) => {
				if (command === "get_merge_sides") return Promise.resolve(sides);
				if (command === "save_merge_result") return Promise.reject(error);
				return read(command, args);
			});
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo", mergePicks },
			});
			vi.mocked(MenuItem.new).mockClear();
			await fireEvent.contextMenu(
				stagingRowFor(await screen.findByTitle(path)),
			);
			const action = await waitFor(() => {
				const item = vi
					.mocked(MenuItem.new)
					.mock.calls.find(([item]) => item.text === "Take All Incoming")?.[0];
				expect(item?.action).toBeDefined();
				return item?.action;
			});
			action?.("Take All Incoming");
			await waitFor(() => expect(toasts.items.at(-1)?.kind).toBe("error"));
			return mergePicks;
		}

		it("makes the selected side available to copy in the editor after a cross-volume refusal", async () => {
			const picks = await takeIncomingWithSaveError({
				code: "merge_recovery_volume",
				message: "Different volumes.",
			});
			expect(picks.draftText("/repo", "src/a.ts")).toBe(
				"a\nB-theirs\nc\nd-ours\ne\nf-theirs\n",
			);
			expect(picks.get("/repo", "src/a.ts")?.refusalReason).toBe(
				"Different volumes.",
			);
			expect(toasts.items.at(-1)?.message).toContain(
				"Open src/a.ts in the merge editor and choose Copy draft.",
			);
		});

		it("points to the file's stage action when Take All saved the working file", async () => {
			await takeIncomingWithSaveError({
				code: "stage_failed",
				message: "Filter failed.",
				working_revision: "after write",
			});
			expect(toasts.items.at(-1)?.message).toContain(
				"Your resolution is in src/a.ts. Use + on that file",
			);
		});
	});

	describe("when resolving conflicted files in bulk", () => {
		const conflicted = [
			{
				path: "src/a.ts",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
			{
				path: "src/b.ts",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
			{
				path: "docs/c.md",
				status: "Conflicted",
				is_binary: false,
				can_take_sides: true,
			},
		];

		async function chooseConflictedFolderMenuItem(
			folder: RegExp,
			text: RegExp,
		) {
			await screen.findByRole("button", { name: "Mark All Resolved" });
			await chooseFolderMenuItem(folder, text);
		}

		beforeEach(() => {
			mockMergeState(conflicted);
		});

		it("resolves only matching conflicts and keeps filtered-out conflicts in the operation total", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});
			await screen.findByRole("button", { name: "Mark All Resolved" });
			await fireEvent.click(
				screen.getByRole("button", { name: "Filter files" }),
			);
			await fireEvent.input(
				screen.getByRole("textbox", { name: "Filter files" }),
				{ target: { value: "docs/" } },
			);
			expect(screen.getByText("1 of 3")).toBeVisible();
			expect(screen.queryByTitle("src/a.ts")).toBeNull();
			await fireEvent.click(
				screen.getByRole("button", { name: "Resolve 1 match" }),
			);
			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("docs/c.md") },
				],
			]);
		});

		it("leaves the manual draft and conflict intact when staging the working file is declined", async () => {
			const mergePicks = createMergePicks();
			mergePicks.set("/repo", "src/b.ts", "snapshot", {
				taken: new Set(),
				typed: "unsaved",
			});
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo", mergePicks },
			});
			vi.mocked(ask).mockResolvedValueOnce(false);
			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);
			await waitFor(() =>
				expect(ask).toHaveBeenCalledWith(
					expect.stringContaining("src/b.ts"),
					expect.objectContaining({ okLabel: "Stage Working Files" }),
				),
			);
			expect(mockInvoke.mock.calls.map(([name]) => name)).not.toContain(
				"mark_conflicts_resolved",
			);
			expect(mergePicks.get("/repo", "src/b.ts")?.picks.typed).toBe("unsaved");
		});
		it("marks every conflicted file resolved in one index update", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);

			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{
						path: "/repo",
						files: resolutions("src/a.ts", "src/b.ts", "docs/c.md"),
					},
				],
			]);
		});

		it.each([
			[
				"Mark All Resolved",
				() =>
					fireEvent.click(
						screen.getByRole("button", { name: "Mark All Resolved" }),
					),
			],
			[
				"a folder's Resolve All",
				() => chooseFolderMenuItem(/^src \(2\)/, /^Resolve All/),
			],
		])(
			"holds the files %s resolves busy until it finishes",
			async (_action, resolve) => {
				const finished = deferred<undefined>();
				const answer = mockInvoke.getMockImplementation();
				if (!answer) throw new Error("the panel's reads have no stub");
				mockInvoke.mockImplementation((cmd, args) =>
					cmd === "mark_conflicts_resolved"
						? finished.promise
						: answer(cmd, args),
				);
				render(StagingPanel, {
					props: {
						...noReviewCounts(),
						repoPath: "/repo",
						treeViewEnabled: true,
					},
				});
				await screen.findByRole("button", { name: "Mark All Resolved" });

				await resolve();
				await waitFor(() =>
					expect(mockInvoke).toHaveBeenCalledWith(
						"mark_conflicts_resolved",
						expect.anything(),
					),
				);
				const whileRunning = folderAction(/^src \(2\)/);
				finished.resolve(undefined);

				expect(whileRunning).toBeNull();
				await waitFor(() => expect(folderAction(/^src \(2\)/)).not.toBeNull());
			},
		);

		it("resolves only the files named by the open folder menu when another conflict arrives", async () => {
			const scheduler = new FakeScheduler();
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					treeViewEnabled: true,
				},
				context: new Map([[SCHEDULER, scheduler]]),
			});
			const row = await screen.findByRole("treeitem", { name: /^src \(2\)/ });
			vi.mocked(MenuItem.new).mockClear();
			await fireEvent.contextMenu(row);
			const selected = await waitFor(() => {
				const item = vi
					.mocked(MenuItem.new)
					.mock.calls.find(
						([options]) => options.text === "Resolve All (2)",
					)?.[0];
				expect(item?.action).toBeDefined();
				return item;
			});
			mockMergeState([...conflicted, { ...conflicted[0], path: "src/new.ts" }]);
			eventHandlers.get("repo-changed")?.({
				payload: { repo: "/repo", paths: [] },
			});
			scheduler.advanceBy(200);
			await screen.findByRole("treeitem", { name: /^src \(3\)/ });
			selected?.action?.(selected.text);
			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("src/a.ts", "src/b.ts") },
				],
			]);
		});

		it("resolves a conflicted directory in one index update", async () => {
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					treeViewEnabled: true,
				},
			});

			await chooseConflictedFolderMenuItem(/^src \(2\)/, /^Resolve All/);

			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("src/a.ts", "src/b.ts") },
				],
			]);
		});

		// Every file under a conflicted folder is still unresolved, so the menu has
		// nothing to unresolve. An item that did unstaged the folder's cleanly merged
		// files, dropping the incoming side from the merge. mockMergeState stages
		// src/main.ts beside the folder's two conflicts.
		it("offers a conflicted folder nothing that touches its staged files", async () => {
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					treeViewEnabled: true,
				},
			});
			await screen.findByRole("button", { name: "Mark All Resolved" });
			const row = screen.getByRole("treeitem", { name: /^src \(2\)/ });
			vi.mocked(MenuItem.new).mockClear();
			vi.mocked(Menu.new).mockClear();
			await fireEvent.contextMenu(row);
			await waitFor(() => expect(Menu.new).toHaveBeenCalled());
			mockInvoke.mockClear();

			for (const [options] of vi.mocked(MenuItem.new).mock.calls) {
				options.action?.(options.text);
			}

			await callsOnceRefreshed("mark_conflicts_resolved");
			const touchingStaged = mockInvoke.mock.calls.filter(([, args]) =>
				JSON.stringify(args ?? {}).includes("src/main.ts"),
			);
			expect(touchingStaged).toEqual([]);
		});

		it("resolves a conflicted directory from its stage action in one index update", async () => {
			render(StagingPanel, {
				props: {
					...noReviewCounts(),
					repoPath: "/repo",
					treeViewEnabled: true,
				},
			});
			await screen.findByRole("button", { name: "Mark All Resolved" });
			const row = screen.getByRole("treeitem", { name: /^src \(2\)/ });
			const rowWithActions = row.parentElement;
			if (rowWithActions === null) throw new Error("folder row is detached");

			await fireEvent.click(
				within(rowWithActions).getByRole("button", { name: "Stage directory" }),
			);

			expect(await callsOnceRefreshed("mark_conflicts_resolved")).toEqual([
				[
					"mark_conflicts_resolved",
					{ path: "/repo", files: resolutions("src/a.ts", "src/b.ts") },
				],
			]);
		});

		describe("when the index write fails", () => {
			const lockedIndex = { code: "git_error", message: "the index is locked" };

			function failCommand(failing: string) {
				const answer = mockInvoke.getMockImplementation();
				if (answer === undefined) throw new Error("merge state is not mocked");
				mockInvoke.mockImplementation(
					(command: string, args?: Record<string, unknown>) =>
						command === failing
							? Promise.reject(lockedIndex)
							: answer(command, args),
				);
			}

			beforeEach(() => {
				_resetToasts();
			});

			it("reports a failed mark-all to the user", async () => {
				failCommand("mark_conflicts_resolved");
				render(StagingPanel, {
					props: { ...noReviewCounts(), repoPath: "/repo" },
				});

				await fireEvent.click(
					await screen.findByRole("button", { name: "Mark All Resolved" }),
				);

				await waitFor(() => {
					expect(toasts.items).toEqual([
						{
							id: expect.any(Number),
							message: "the index is locked",
							kind: "error",
						},
					]);
				});
				await callsOnceRefreshed("mark_conflicts_resolved");
			});

			it("reports a failed folder resolve to the user", async () => {
				failCommand("mark_conflicts_resolved");
				render(StagingPanel, {
					props: {
						...noReviewCounts(),
						repoPath: "/repo",
						treeViewEnabled: true,
					},
				});

				await chooseConflictedFolderMenuItem(/^src \(2\)/, /^Resolve All/);

				await waitFor(() => {
					expect(toasts.items).toEqual([
						{
							id: expect.any(Number),
							message: "the index is locked",
							kind: "error",
						},
					]);
				});
				await callsOnceRefreshed("mark_conflicts_resolved");
			});

			it("reports a failed refresh after the resolve", async () => {
				render(StagingPanel, {
					props: { ...noReviewCounts(), repoPath: "/repo" },
				});
				const markAll = await screen.findByRole("button", {
					name: "Mark All Resolved",
				});
				failCommand("get_status");

				await fireEvent.click(markAll);

				await waitFor(() => {
					expect(toasts.items).toEqual([
						{
							id: expect.any(Number),
							message: "the index is locked",
							kind: "error",
						},
					]);
				});
			});
		});
	});
});

function withOneUntrackedFileInSrc() {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd === "get_status")
			return Promise.resolve({
				unstaged: [
					{ path: "src/a.ts", status: "Modified", is_binary: false },
					{ path: "src/b.ts", status: "New", is_binary: false },
					{ path: "docs/c.md", status: "Modified", is_binary: false },
				],
				staged: [],
				conflicted: [],
			});
		if (cmd === "get_operation_state")
			return Promise.resolve({
				op_type: "None",
				source_branch: null,
				target_branch: null,
				onto_oid: null,
				progress: null,
				rebase_message: null,
				commit: null,
			});
		return Promise.resolve(undefined);
	});
	vi.mocked(ask).mockReset().mockResolvedValueOnce(true);
}

describe("StagingPanel discarding every change", () => {
	beforeEach(withOneUntrackedFileInSrc);

	it("discards only the files the user confirmed", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: "Discard all changes" }),
		);

		expect(await callsOnceRefreshed("discard_all")).toEqual([
			[
				"discard_all",
				{ path: "/repo", filePaths: ["src/a.ts", "src/b.ts", "docs/c.md"] },
			],
		]);
	});

	it("discards the matching edit and leaves a hidden untracked file alone", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});
		await fireEvent.click(
			await screen.findByRole("button", { name: "Filter files" }),
		);
		await fireEvent.input(
			screen.getByRole("textbox", { name: "Filter files" }),
			{
				target: { value: "docs/" },
			},
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Discard 1 match" }),
		);

		expect(await callsOnceRefreshed("discard_all")).toEqual([
			["discard_all", { path: "/repo", filePaths: ["docs/c.md"] }],
		]);
		expect(ask).toHaveBeenCalledWith(
			"Discard all changes to 1 file matching the filter? This cannot be undone.",
			expect.objectContaining({ okLabel: "Discard 1 match" }),
		);
	});

	it("warns that the untracked file will be deleted", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: "Discard all changes" }),
		);

		await waitFor(() =>
			expect(ask).toHaveBeenCalledWith(
				"Discard all changes to 3 files? This deletes 1 untracked file and cannot be undone.",
				expect.objectContaining({ okLabel: "Discard All" }),
			),
		);
	});
});

describe("StagingPanel discarding a folder", () => {
	beforeEach(withOneUntrackedFileInSrc);

	it("warns that the folder's untracked file will be deleted", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				treeViewEnabled: true,
			},
		});

		await chooseFolderMenuItem(/^src \(2\)/, /^Discard All/);

		await waitFor(() =>
			expect(ask).toHaveBeenCalledWith(
				"Discard all changes in src/ (2 files)? This deletes 1 untracked file and cannot be undone.",
				expect.objectContaining({ okLabel: "Discard" }),
			),
		);
	});

	it("discards the folder's changes in one index update", async () => {
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				treeViewEnabled: true,
			},
		});

		await chooseFolderMenuItem(/^src \(2\)/, /^Discard All/);

		expect(await callsOnceRefreshed("discard_file")).toEqual([
			["discard_files", { path: "/repo", filePaths: ["src/a.ts", "src/b.ts"] }],
		]);
	});

	it("holds the folder's files busy until the discard finishes", async () => {
		const finished = deferred<undefined>();
		const answer = mockInvoke.getMockImplementation();
		if (!answer) throw new Error("the panel's reads have no stub");
		mockInvoke.mockImplementation((cmd, args) =>
			cmd === "discard_files" ? finished.promise : answer(cmd, args),
		);
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				treeViewEnabled: true,
			},
		});

		await chooseFolderMenuItem(/^src \(2\)/, /^Discard All/);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"discard_files",
				expect.anything(),
			),
		);
		const whileRunning = folderAction(/^src \(2\)/);
		finished.resolve(undefined);

		expect(whileRunning).toBeNull();
		await waitFor(() => expect(folderAction(/^src \(2\)/)).not.toBeNull());
	});

	it("reports a failed discard and shows what it left behind", async () => {
		_resetToasts();
		const answer = mockInvoke.getMockImplementation();
		if (answer === undefined) throw new Error("status is not mocked");
		mockInvoke.mockImplementation(
			(command: string, args?: Record<string, unknown>) =>
				command === "discard_files"
					? Promise.reject({ code: "io_error", message: "permission denied" })
					: answer(command, args),
		);
		render(StagingPanel, {
			props: {
				...noReviewCounts(),
				repoPath: "/repo",
				treeViewEnabled: true,
			},
		});

		await chooseFolderMenuItem(/^src \(2\)/, /^Discard All/);

		await callsOnceRefreshed("discard_file");
		expect(toasts.items).toEqual([
			{ id: expect.any(Number), message: "permission denied", kind: "error" },
		]);
	});
});

describe("StagingPanel discarding a file", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({
					unstaged: [
						{ path: "README.md", status: "Modified", is_binary: false },
					],
					staged: [],
					conflicted: [],
				});
			if (cmd === "get_operation_state")
				return Promise.resolve({
					op_type: "None",
					source_branch: null,
					target_branch: null,
					onto_oid: null,
					progress: null,
					rebase_message: null,
					commit: null,
				});
			return Promise.resolve(undefined);
		});
		vi.mocked(ask).mockResolvedValueOnce(true);
	});

	async function chooseDiscardChanges() {
		const row = stagingRowFor(await screen.findByText("README.md"));
		vi.mocked(MenuItem.new).mockClear();
		await fireEvent.contextMenu(row);
		const item = await waitFor(() => {
			const found = vi
				.mocked(MenuItem.new)
				.mock.calls.map(([options]) => options)
				.find((options) => options.text === "Discard Changes");
			expect(found?.action).toBeDefined();
			return found;
		});
		item?.action?.(item.text);
	}

	it("holds the file busy until the discard finishes", async () => {
		const finished = deferred<undefined>();
		const answer = mockInvoke.getMockImplementation();
		if (!answer) throw new Error("the panel's reads have no stub");
		mockInvoke.mockImplementation((cmd, args) =>
			cmd === "discard_file" ? finished.promise : answer(cmd, args),
		);
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});

		await chooseDiscardChanges();
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discard_file", {
				path: "/repo",
				filePath: "README.md",
			}),
		);
		const whileRunning = rowAction("README.md", "Stage file");
		finished.resolve(undefined);

		expect(whileRunning).toBeNull();
		await waitFor(() =>
			expect(rowAction("README.md", "Stage file")).not.toBeNull(),
		);
	});

	it("reports a failed discard and shows what it left behind", async () => {
		_resetToasts();
		const answer = mockInvoke.getMockImplementation();
		if (answer === undefined) throw new Error("status is not mocked");
		mockInvoke.mockImplementation(
			(command: string, args?: Record<string, unknown>) =>
				command === "discard_file"
					? Promise.reject({ code: "io_error", message: "permission denied" })
					: answer(command, args),
		);
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/repo" },
		});

		await chooseDiscardChanges();

		await callsOnceRefreshed("discard_file");
		expect(toasts.items).toEqual([
			{ id: expect.any(Number), message: "permission denied", kind: "error" },
		]);
	});
});

describe("StagingPanel rebase form", () => {
	beforeEach(() => {
		vi.mocked(writeText).mockClear();
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({ unstaged: [], staged: [], conflicted: [] });
			if (cmd === "get_operation_state")
				return Promise.resolve({
					op_type: "Rebase",
					source_branch: "feature",
					target_branch: "main",
					onto_oid: null,
					progress: "2/5",
					rebase_message: "reword the parser",
					commit: null,
				});
			return Promise.resolve(undefined);
		});
	});

	async function renderRebaseForm() {
		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });
		const progress = await screen.findByText("Rebasing commit 2 out of 5");
		const form = progress.parentElement;
		if (!form) throw new Error("expected the progress line inside the form");

		return {
			form,
			handle: screen.getByRole("slider", { name: "Resize rebase form" }),
		};
	}

	async function press(handle: HTMLElement, key: string, times: number) {
		for (let count = 0; count < times; count++) {
			await fireEvent.keyDown(handle, { key });
		}
	}

	it.each(["feature", "main"])(
		"copies %s when its branch chip is pressed",
		async (name) => {
			await renderRebaseForm();

			await fireEvent.click(screen.getByRole("button", { name }));

			expect(vi.mocked(writeText)).toHaveBeenCalledWith(name);
		},
	);

	it("labels its abort button Abort", async () => {
		await renderRebaseForm();

		expect(screen.getByRole("button", { name: "Abort" })).toBeEnabled();
	});

	describe("when no branch points at the commit it rebases onto", () => {
		const ONTO = "7d6008b2c4e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7";

		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "get_status")
					return Promise.resolve({ unstaged: [], staged: [], conflicted: [] });
				if (cmd === "get_operation_state")
					return Promise.resolve({
						op_type: "Rebase",
						source_branch: "feature",
						target_branch: null,
						onto_oid: ONTO,
						progress: "2/5",
						rebase_message: null,
						commit: null,
					});
				return Promise.resolve(undefined);
			});
		});

		it("copies the commit's full SHA when its chip is pressed", async () => {
			await renderRebaseForm();

			await fireEvent.click(screen.getByRole("button", { name: "7d6008b" }));

			expect(vi.mocked(writeText)).toHaveBeenCalledWith(ONTO);
		});
	});

	it("grows by a step when the handle above it takes ArrowUp", async () => {
		const { form, handle } = await renderRebaseForm();

		await press(handle, "ArrowUp", 1);

		expect(form.style.height).toBe("228px");
		expect(handle).toHaveAttribute("aria-valuenow", "228");
	});

	it("shrinks by a step when the handle takes ArrowDown", async () => {
		const { form, handle } = await renderRebaseForm();

		await press(handle, "ArrowDown", 1);

		expect(form.style.height).toBe("212px");
	});

	it.each([
		{ key: "ArrowUp", limit: "tallest", height: "500px" },
		{ key: "ArrowDown", limit: "shortest", height: "168px" },
	])(
		"stops at the $limit height a drag stops it at",
		async ({ key, height }) => {
			const { form, handle } = await renderRebaseForm();

			await press(handle, key, 41);

			expect(form.style.height).toBe(height);
		},
	);

	it("follows a drag of the handle", async () => {
		const { form, handle } = await renderRebaseForm();

		await fireEvent.mouseDown(handle, { clientY: 400 });
		await fireEvent.mouseMove(window, { clientY: 360 });
		await fireEvent.mouseUp(window);

		expect(form.style.height).toBe("260px");
	});

	it.each([
		{ limit: "tallest", to: 0, height: "500px" },
		{ limit: "shortest", to: 800, height: "168px" },
	])("stops a drag at the $limit height", async ({ to, height }) => {
		const { form, handle } = await renderRebaseForm();

		await fireEvent.mouseDown(handle, { clientY: 400 });
		await fireEvent.mouseMove(window, { clientY: to });
		await fireEvent.mouseUp(window);

		expect(form.style.height).toBe(height);
	});
});

describe("StagingPanel with no rebase form", () => {
	function mockOperation(opType: string | null, conflicted: unknown[] = []) {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({ unstaged: [], staged: [], conflicted });
			if (cmd === "get_operation_state" && opType)
				return Promise.resolve({
					op_type: opType,
					source_branch: "feature",
					target_branch: "main",
					onto_oid: null,
					progress: null,
					rebase_message: null,
					commit: null,
				});
			return Promise.resolve(undefined);
		});
	}

	it.each(["CherryPick", "Revert"])(
		"keeps Continue off while a stopped %s still has a conflicted file",
		async (opType) => {
			mockOperation(opType, [
				{
					path: "src/a.ts",
					status: "Conflicted",
					is_binary: false,
					can_take_sides: true,
				},
			]);

			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			expect(
				await screen.findByRole("button", { name: "Continue" }),
			).toBeDisabled();
		},
	);

	it.each([
		{ state: "nothing is in progress", opType: null, shown: "Staged files" },
		{ state: "a merge is stopped", opType: "Merge", shown: "Abort Merge" },
	])(
		"draws the line above the form as no control while $state",
		async ({ opType, shown }) => {
			mockOperation(opType);

			const { container } = render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});
			await screen.findByText(shown);

			expect(screen.queryByRole("slider")).toBeNull();
			expect(container.querySelectorAll(".splitter-bar")).toHaveLength(1);
		},
	);
});
