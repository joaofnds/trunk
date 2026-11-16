import { MenuItem } from "@tauri-apps/api/menu";
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { noReviewCounts } from "../__tests__/helpers/review-props.js";
import { safeInvoke } from "../lib/invoke.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import type { ReviewTally } from "../lib/types.js";
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
	message: vi.fn().mockResolvedValue(undefined),
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
				});
			return Promise.resolve(undefined);
		});
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

	it("folds a section's files away when its header is clicked", async () => {
		render(StagingPanel, {
			props: { ...noReviewCounts(), repoPath: "/test/repo" },
		});
		const header = await screen.findByRole("button", {
			name: /Unstaged Files/,
		});
		expect(screen.getAllByTestId("staging-file")).toHaveLength(2);

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
	function mockMergeState(
		conflicted: unknown[] = [],
		unstaged: unknown[] = [],
	) {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
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

	it("hides an empty unstaged list beside a merge's conflicts", async () => {
		mockMergeState([
			{ path: "src/a.ts", status: "Conflicted", is_binary: false },
		]);

		render(StagingPanel, { props: { ...noReviewCounts(), repoPath: "/repo" } });

		await screen.findByRole("button", { name: "Mark All Resolved" });
		expect(screen.queryByTestId("staging-unstaged-section")).toBeNull();
	});

	it("moves a staged conflict into the staged list before the status answers", async () => {
		mockMergeState([
			{ path: "src/a.ts", status: "Conflicted", is_binary: false },
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
		const row = stagingRowFor(await screen.findByText("src/a.ts"));
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

			expect(screen.getByText("src/a.ts")).toBeInTheDocument();
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
			const row = stagingRowFor(screen.getByText("src/a.ts"));
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
		const sides = {
			base: "a\nb\nc\nd\ne\nf\n",
			ours: "a\nB-ours\nc\nd-ours\ne\nf\n",
			theirs: "a\nB-theirs\nc\nd\ne\nf-theirs\n",
		};

		it.each([
			["Take All Current", "a\nB-ours\nc\nd-ours\ne\nf-theirs\n"],
			["Take All Incoming", "a\nB-theirs\nc\nd-ours\ne\nf-theirs\n"],
		])(
			"%s keeps what only the other side changed, as the editor does",
			async (text, merged) => {
				mockMergeState([
					{ path: "src/a.ts", status: "Conflicted", is_binary: false },
				]);
				const answer = mockInvoke.getMockImplementation();
				if (answer === undefined) throw new Error("merge state is not mocked");
				mockInvoke.mockImplementation(
					(command: string, args?: Record<string, unknown>) =>
						command === "get_merge_sides"
							? Promise.resolve(sides)
							: answer(command, args),
				);
				render(StagingPanel, {
					props: { ...noReviewCounts(), repoPath: "/repo" },
				});
				const row = stagingRowFor(await screen.findByText("src/a.ts"));
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
						path: "/repo",
						filePath: "src/a.ts",
						content: merged,
					}),
				);
			},
		);
	});

	describe("when resolving conflicted files in bulk", () => {
		const conflicted = [
			{ path: "src/a.ts", status: "Conflicted", is_binary: false },
			{ path: "src/b.ts", status: "Conflicted", is_binary: false },
			{ path: "docs/c.md", status: "Conflicted", is_binary: false },
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

		it("marks every conflicted file resolved in one index update", async () => {
			render(StagingPanel, {
				props: { ...noReviewCounts(), repoPath: "/repo" },
			});

			await fireEvent.click(
				await screen.findByRole("button", { name: "Mark All Resolved" }),
			);

			expect(await callsOnceRefreshed("stage_file")).toEqual([
				[
					"stage_files",
					{ path: "/repo", filePaths: ["src/a.ts", "src/b.ts", "docs/c.md"] },
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

			expect(await callsOnceRefreshed("stage_file")).toEqual([
				["stage_files", { path: "/repo", filePaths: ["src/a.ts", "src/b.ts"] }],
			]);
		});

		// Every file under a conflicted folder is still unresolved, so the menu has
		// nothing to unresolve. An item that did unstaged the folder's cleanly merged
		// files, dropping the incoming side from the merge.
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
			const items = () =>
				vi.mocked(MenuItem.new).mock.calls.map(([options]) => options.text);

			await fireEvent.contextMenu(row);

			await waitFor(() => expect(items()).toContain("Resolve All (2)"));
			expect(items()).toEqual([
				"Copy Relative Path",
				"Copy Absolute Path",
				"Resolve All (2)",
			]);
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

			expect(await callsOnceRefreshed("stage_file")).toEqual([
				["stage_files", { path: "/repo", filePaths: ["src/a.ts", "src/b.ts"] }],
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
				failCommand("stage_files");
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
				await callsOnceRefreshed("stage_files");
			});

			it("reports a failed folder resolve to the user", async () => {
				failCommand("stage_files");
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
				await callsOnceRefreshed("stage_files");
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

describe("StagingPanel discarding a folder", () => {
	beforeEach(() => {
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
				});
			return Promise.resolve(undefined);
		});
		vi.mocked(ask).mockResolvedValueOnce(true);
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

		expect(form.style.height).toBe("188px");
		expect(handle).toHaveAttribute("aria-valuenow", "188");
	});

	it("shrinks by a step when the handle takes ArrowDown", async () => {
		const { form, handle } = await renderRebaseForm();

		await press(handle, "ArrowDown", 1);

		expect(form.style.height).toBe("172px");
	});

	it.each([
		{ key: "ArrowUp", limit: "tallest", height: "500px" },
		{ key: "ArrowDown", limit: "shortest", height: "100px" },
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

		expect(form.style.height).toBe("220px");
	});

	it.each([
		{ limit: "tallest", to: 0, height: "500px" },
		{ limit: "shortest", to: 800, height: "100px" },
	])("stops a drag at the $limit height", async ({ to, height }) => {
		const { form, handle } = await renderRebaseForm();

		await fireEvent.mouseDown(handle, { clientY: 400 });
		await fireEvent.mouseMove(window, { clientY: to });
		await fireEvent.mouseUp(window);

		expect(form.style.height).toBe(height);
	});
});

describe("StagingPanel with no rebase form", () => {
	function mockOperation(opType: string | null) {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_status")
				return Promise.resolve({ unstaged: [], staged: [], conflicted: [] });
			if (cmd === "get_operation_state" && opType)
				return Promise.resolve({
					op_type: opType,
					source_branch: "feature",
					target_branch: "main",
					onto_oid: null,
					progress: null,
					rebase_message: null,
				});
			return Promise.resolve(undefined);
		});
	}

	it.each([
		{ state: "nothing is in progress", opType: null, shown: "Staged Files" },
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
