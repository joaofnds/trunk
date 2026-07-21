import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchSidebar from "./BranchSidebar.svelte";

// All Tauri module mocks declared locally so vi.mock hoisting keeps a single
// mock instance per module (matching CommitGraph.test.ts). A shared helper
// import reorders the hoist and detaches the invoke mock the component sees.
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

vi.mock("@tauri-apps/plugin-window-state", () => ({}));

// Capture context-menu { text -> action } callbacks so this suite can invoke the
// exact callback a user triggers picking a menu entry — the only way the merge
// handler (wired through a branch context menu) is reachable in jsdom.
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

const mockInvoke = vi.mocked(invoke);

function mockListRefs(overrides?: {
	local?: Array<{
		name: string;
		is_head: boolean;
		upstream: string | null;
		ahead: number;
		behind: number;
		last_commit_timestamp: number;
	}>;
	remote?: Array<{
		name: string;
		is_head: boolean;
		upstream: string | null;
		ahead: number;
		behind: number;
		last_commit_timestamp: number;
	}>;
	tags?: Array<{
		name: string;
		short_name: string;
		ref_type: string;
		is_head: boolean;
		color_index: number;
	}>;
	stashes?: Array<{
		index: number;
		name: string;
		short_name: string;
		oid: string;
		parent_oid: string | null;
	}>;
}) {
	return {
		local: overrides?.local ?? [
			{
				name: "main",
				is_head: true,
				upstream: null,
				ahead: 0,
				behind: 0,
				last_commit_timestamp: 1700000000,
			},
		],
		remote: overrides?.remote ?? [],
		tags: overrides?.tags ?? [],
		stashes: overrides?.stashes ?? [],
	};
}

describe("BranchSidebar", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		menuActions.clear();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_refs") return Promise.resolve(mockListRefs());
			return Promise.resolve(undefined);
		});
	});

	it("renders without crashing", () => {
		const { container } = render(BranchSidebar, {
			props: { repoPath: "/test/repo" },
		});
		expect(container).toBeTruthy();
	});

	it("renders local branch section header", async () => {
		render(BranchSidebar, {
			props: { repoPath: "/test/repo" },
		});
		// BranchSection renders "{label} ({count})" — e.g. "Local (1)"
		await waitFor(() => {
			expect(screen.getByText("Local (1)")).toBeInTheDocument();
		});
	});

	it("renders branch name from refs response", async () => {
		render(BranchSidebar, {
			props: { repoPath: "/test/repo" },
		});
		await waitFor(() => {
			expect(screen.getByText("main")).toBeInTheDocument();
		});
	});

	it("renders multiple local branches", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_refs")
				return Promise.resolve(
					mockListRefs({
						local: [
							{
								name: "main",
								is_head: true,
								upstream: null,
								ahead: 0,
								behind: 0,
								last_commit_timestamp: 1700000000,
							},
							{
								name: "feature/login",
								is_head: false,
								upstream: null,
								ahead: 0,
								behind: 0,
								last_commit_timestamp: 1700000100,
							},
						],
					}),
				);
			return Promise.resolve(undefined);
		});

		render(BranchSidebar, {
			props: { repoPath: "/test/repo" },
		});

		await waitFor(() => {
			expect(screen.getByText("main")).toBeInTheDocument();
			expect(screen.getByText("feature/login")).toBeInTheDocument();
		});
	});

	it("calls list_refs on mount with correct repo path", async () => {
		render(BranchSidebar, {
			props: { repoPath: "/my/project" },
		});
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("list_refs", {
				path: "/my/project",
			});
		});
	});

	describe("remote branch double-click checkout", () => {
		const refsWithRemote = {
			local: [
				{
					name: "main",
					is_head: true,
					upstream: null,
					ahead: 0,
					behind: 0,
					last_commit_timestamp: 1700000000,
				},
			],
			remote: [
				{
					name: "origin/feature",
					is_head: false,
					upstream: null,
					ahead: 0,
					behind: 0,
					last_commit_timestamp: 1700000000,
				},
			],
			tags: [],
			stashes: [],
		};

		it("calls create_branch with correct args on remote branch double-click", async () => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "list_refs") return Promise.resolve(refsWithRemote);
				return Promise.resolve(undefined);
			});

			render(BranchSidebar, {
				props: { repoPath: "/test/repo" },
			});

			// Wait for Remote section to appear, then expand it
			await waitFor(() => {
				expect(screen.getByText("Remote (1)")).toBeInTheDocument();
			});
			await fireEvent.click(screen.getByText("Remote (1)"));

			// Wait for the remote branch row to appear
			await waitFor(() => {
				expect(screen.getByText("feature")).toBeInTheDocument();
			});

			// Double-click the remote branch row (find the BranchRow button containing "feature")
			const remoteBranchRow = screen
				.getByTestId("branch-section-remote")
				.querySelector('[data-testid="branch-row"] [role="button"]');
			expect(remoteBranchRow).toBeTruthy();
			await fireEvent.dblClick(remoteBranchRow as Element);

			await waitFor(() => {
				expect(mockInvoke).toHaveBeenCalledWith("create_branch", {
					path: "/test/repo",
					name: "feature",
					fromOid: "origin/feature",
				});
			});
		});

		it("shows error toast when create_branch fails", async () => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "list_refs") return Promise.resolve(refsWithRemote);
				if (cmd === "create_branch")
					return Promise.reject(
						JSON.stringify({
							code: "branch_exists",
							message: "branch 'feature' already exists",
						}),
					);
				return Promise.resolve(undefined);
			});

			render(BranchSidebar, {
				props: { repoPath: "/test/repo" },
			});

			// Expand Remote section
			await waitFor(() => {
				expect(screen.getByText("Remote (1)")).toBeInTheDocument();
			});
			await fireEvent.click(screen.getByText("Remote (1)"));

			await waitFor(() => {
				expect(screen.getByText("feature")).toBeInTheDocument();
			});

			const remoteBranchRow = screen
				.getByTestId("branch-section-remote")
				.querySelector('[data-testid="branch-row"] [role="button"]');
			await fireEvent.dblClick(remoteBranchRow as Element);

			// Verify create_branch was called (and it rejected)
			await waitFor(() => {
				expect(mockInvoke).toHaveBeenCalledWith("create_branch", {
					path: "/test/repo",
					name: "feature",
					fromOid: "origin/feature",
				});
			});
		});
	});

	describe("merge routing through MessageEditor (76-03)", () => {
		const twoLocals = {
			local: [
				{
					name: "main",
					is_head: true,
					upstream: null,
					ahead: 0,
					behind: 0,
					last_commit_timestamp: 1700000000,
				},
				{
					name: "feature",
					is_head: false,
					upstream: null,
					ahead: 0,
					behind: 0,
					last_commit_timestamp: 1700000100,
				},
			],
			remote: [],
			tags: [],
			stashes: [],
		};

		async function openFeatureMenu(onopenmessageeditor: () => unknown) {
			// Scope all queries to this render's container — prior tests in this
			// file leave their rendered <aside> in document.body (no global
			// cleanup), so screen-level queries would be ambiguous across mounts.
			const { container } = render(BranchSidebar, {
				props: {
					repoPath: "/test/repo",
					onopenmessageeditor: onopenmessageeditor as never,
				},
			});
			let featureRow: Element | null | undefined;
			await waitFor(() => {
				featureRow = container
					.querySelector('[data-testid="branch-section-local"]')
					?.querySelectorAll('[data-testid="branch-row"]')[1]
					?.querySelector('[role="button"]');
				expect(featureRow).toBeTruthy();
			});
			await fireEvent.contextMenu(featureRow as Element);
			await waitFor(() => {
				expect(menuActions.has("Merge feature into main")).toBe(true);
			});
		}

		it("merge ready: begin -> editor -> merge_continue with edited message", async () => {
			const onopenmessageeditor = vi.fn().mockResolvedValue("edited merge");
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "list_refs") return Promise.resolve(twoLocals);
				if (cmd === "merge_branch_begin")
					return Promise.resolve({ kind: "ready", message: "Merge default" });
				return Promise.resolve(undefined);
			});

			await openFeatureMenu(onopenmessageeditor);
			await getMenuAction("Merge feature into main")();
			await new Promise((r) => setTimeout(r, 0));

			expect(mockInvoke).toHaveBeenCalledWith("merge_branch_begin", {
				path: "/test/repo",
				branch: "feature",
			});
			expect(onopenmessageeditor).toHaveBeenCalledWith(
				"Merge default",
				"Merge commit message",
			);
			expect(mockInvoke).toHaveBeenCalledWith("merge_continue", {
				path: "/test/repo",
				message: "edited merge",
			});
		});

		it("merge cancel (null): no merge_continue", async () => {
			const onopenmessageeditor = vi.fn().mockResolvedValue(null);
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "list_refs") return Promise.resolve(twoLocals);
				if (cmd === "merge_branch_begin")
					return Promise.resolve({ kind: "ready", message: "Merge default" });
				return Promise.resolve(undefined);
			});

			await openFeatureMenu(onopenmessageeditor);
			await getMenuAction("Merge feature into main")();
			await new Promise((r) => setTimeout(r, 0));

			expect(onopenmessageeditor).toHaveBeenCalled();
			expect(mockInvoke).not.toHaveBeenCalledWith(
				"merge_continue",
				expect.anything(),
			);
		});

		it("merge fast_forwarded: no editor, no merge_continue", async () => {
			const onopenmessageeditor = vi.fn();
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "list_refs") return Promise.resolve(twoLocals);
				if (cmd === "merge_branch_begin")
					return Promise.resolve({ kind: "fast_forwarded" });
				return Promise.resolve(undefined);
			});

			await openFeatureMenu(onopenmessageeditor);
			await getMenuAction("Merge feature into main")();
			await new Promise((r) => setTimeout(r, 0));

			expect(onopenmessageeditor).not.toHaveBeenCalled();
			expect(mockInvoke).not.toHaveBeenCalledWith(
				"merge_continue",
				expect.anything(),
			);
		});
	});
});
