import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toasts } from "../lib/toast.svelte.js";
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

// Prefs are a plain map here: the suite asserts on what was persisted, and a repo's
// hidden set has to survive a reload of the component.
const prefsStore = new Map<string, unknown>();

describe("BranchSidebar", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		menuActions.clear();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_refs") return Promise.resolve(mockListRefs());
			return Promise.resolve(undefined);
		});
	});

	// The message names a condition, not an event: it says the working tree has
	// uncommitted changes. Once that stops being true it is telling the user
	// something false, and only typing in the search box took it away.
	it("takes the checkout refusal down once the working tree is clean again", async () => {
		let dirty = true;
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
								name: "feature",
								is_head: false,
								upstream: null,
								ahead: 0,
								behind: 0,
								last_commit_timestamp: 1700000000,
							},
						],
					}),
				);
			// Tauri hands an IPC failure back as a JSON string, which safeInvoke
			// parses; rejecting with an object reaches the handler as unknown_error.
			if (cmd === "checkout_branch" && dirty)
				return Promise.reject(
					JSON.stringify({
						code: "dirty_workdir",
						message: "Working tree has uncommitted changes",
					}),
				);
			return Promise.resolve(undefined);
		});

		const { rerender } = render(BranchSidebar, {
			props: {
				repoPath: "/test/repo",
				refreshSignal: 0,
				workingTreeDirty: true,
			},
		});

		const label = await waitFor(() => screen.getByText("feature"));
		const row = label.closest('[role="button"]');
		if (!row) throw new Error("the feature row offers no control");
		await fireEvent.dblClick(row);
		await waitFor(() =>
			expect(screen.getByText(/Cannot checkout/)).toBeInTheDocument(),
		);

		// A refresh unrelated to the working tree (e.g. creating a tag) must not
		// take the message down while the tree is still dirty.
		await rerender({
			repoPath: "/test/repo",
			refreshSignal: 1,
			workingTreeDirty: true,
		});
		expect(screen.getByText(/Cannot checkout/)).toBeInTheDocument();

		dirty = false;
		await rerender({
			repoPath: "/test/repo",
			refreshSignal: 1,
			workingTreeDirty: false,
		});

		await waitFor(() =>
			expect(screen.queryByText(/Cannot checkout/)).not.toBeInTheDocument(),
		);
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

describe("BranchSidebar ref visibility", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		menuActions.clear();
		prefsStore.clear();
		mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === "list_refs") {
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
								name: "topic",
								is_head: false,
								upstream: null,
								ahead: 0,
								behind: 0,
								last_commit_timestamp: 1700000000,
							},
						],
					}),
				);
			}
			if (cmd === "prefs_get") {
				return Promise.resolve(
					prefsStore.get((args as { key: string })?.key) ?? null,
				);
			}
			if (cmd === "prefs_set") {
				prefsStore.set(
					(args as { key: string }).key,
					(args as { value: unknown }).value,
				);
				return Promise.resolve(undefined);
			}
			return Promise.resolve(undefined);
		});
	});

	// The section toggle is a bulk action over the rows it covers, not a rule of its own.
	// It writes each hideable row's own entry, so the eye on a row always shows that row's
	// real state (João, 2026-09-02).
	it("hiding a section writes every hideable row, skipping HEAD's branch", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		// Wait for the rows themselves, not just the section header: the header renders
		// while the refs are still loading, and a bulk action then covers nothing.
		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Hide all Local refs"));

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"set_ref_visibility",
				expect.objectContaining({
					visibility: { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] },
				}),
			);
		});
	});

	// The defect this replaced: the section flag overrode the rows, so a row under a hidden
	// section showed as hidden while its own state said otherwise, and showing the section
	// resurrected rows the user had hidden individually.
	it("shows each row's own state, not the section's", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Hide all Local refs"));

		// Every hideable row now reads as hidden, because it really is.
		await waitFor(() => {
			expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
		});

		// Showing one row back leaves the section partly hidden, and the row says so.
		await fireEvent.click(screen.getByLabelText("Show topic"));
		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
	});

	// A section whose rows are all hidden offers to show them, so the icon never lies about
	// what one more click will do.
	it("offers to show a section once every row under it is hidden", async () => {
		prefsStore.set("ref_visibility", {
			"/test/repo": { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] },
		});

		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		// main is HEAD and cannot be hidden, so topic alone being hidden makes the whole
		// section hidden as far as the user can act on it.
		await waitFor(() => {
			expect(screen.getByLabelText("Show all Local refs")).toBeInTheDocument();
		});
	});

	// Showing a section clears every row it covers, leaving nothing hidden behind it.
	it("showing a section clears every row under it", async () => {
		prefsStore.set("ref_visibility", {
			"/test/repo": { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] },
		});

		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Show all Local refs")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Show all Local refs"));

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"set_ref_visibility",
				expect.objectContaining({
					visibility: { hiddenRefs: [], hiddenStashes: [] },
				}),
			);
		});
	});

	// Acceptance #5: HEAD's branch row offers no toggle, every other row does.
	it("offers a toggle on every row but HEAD's branch", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		expect(screen.queryByLabelText("Hide main")).not.toBeInTheDocument();
	});

	// Acceptance #1 and #2: the toggle pushes the new set to the backend, which rebuilds
	// the graph, so the pills update and stay updated across a reload.
	it("pushes the hidden set to the backend when a row is toggled", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Hide topic"));

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"set_ref_visibility",
				expect.objectContaining({
					path: "/test/repo",
					visibility: expect.objectContaining({
						hiddenRefs: ["refs/heads/topic"],
					}),
				}),
			);
		});
	});

	// Acceptance #7: the same hidden set comes back when the repository is reopened.
	it("persists the hidden set to prefs", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Hide topic"));

		await waitFor(() => {
			expect(prefsStore.get("ref_visibility")).toEqual({
				"/test/repo": expect.objectContaining({
					hiddenRefs: ["refs/heads/topic"],
				}),
			});
		});
	});

	// Acceptance #6: a hidden ref stays listed, marked hidden, so it can be turned back on.
	it("keeps a hidden row listed and marked", async () => {
		prefsStore.set("ref_visibility", {
			"/test/repo": {
				hiddenRefs: ["refs/heads/topic"],
				hiddenStashes: [],
			},
		});

		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
		});
		expect(screen.getByText("topic")).toBeInTheDocument();
	});

	// Opening a repository has to push the stored set, or the first graph shows refs the
	// user hid in an earlier session.
	it("pushes the stored set to the backend on open", async () => {
		prefsStore.set("ref_visibility", {
			"/test/repo": {
				hiddenRefs: ["refs/heads/topic"],
				hiddenStashes: [],
			},
		});

		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"set_ref_visibility",
				expect.objectContaining({ path: "/test/repo" }),
			);
		});
	});

	// Acceptance #5: a stash row carries a toggle like every other row. A stash has no
	// stable name, so it is keyed by its commit OID.
	it("offers a toggle on a stash row, keyed by its oid", async () => {
		mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === "list_refs") {
				return Promise.resolve(
					mockListRefs({
						stashes: [
							{
								index: 0,
								name: "WIP on main",
								short_name: "stash@{0}",
								oid: "abc123",
								parent_oid: null,
							},
						],
					}),
				);
			}
			if (cmd === "prefs_get") {
				return Promise.resolve(
					prefsStore.get((args as { key: string })?.key) ?? null,
				);
			}
			if (cmd === "prefs_set") {
				prefsStore.set(
					(args as { key: string }).key,
					(args as { value: unknown }).value,
				);
				return Promise.resolve(undefined);
			}
			return Promise.resolve(undefined);
		});

		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await fireEvent.click(await screen.findByText("Stashes (1)"));
		await fireEvent.click(await screen.findByLabelText("Hide stash@{0}"));

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"set_ref_visibility",
				expect.objectContaining({
					visibility: expect.objectContaining({ hiddenStashes: ["abc123"] }),
				}),
			);
		});
	});

	// TRUNK-129: saving the hidden set is not on the path between the click and the graph,
	// and a save that fails must not take the toggled graph back with it.
	it("keeps the toggled graph and reports when the hidden set cannot be saved", async () => {
		const base = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === "set_ref_visibility")
				return Promise.resolve({ commits: [], max_columns: 0 });
			if (cmd === "prefs_set")
				return Promise.reject(
					JSON.stringify({ code: "io_error", message: "disk full" }),
				);
			return base?.(cmd, args);
		});
		const received: unknown[] = [];
		render(BranchSidebar, {
			props: {
				repoPath: "/test/repo",
				onvisibilitychanged: (graph) => received.push(graph),
			},
		});
		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByLabelText("Hide topic"));

		await waitFor(() => {
			expect(received).toEqual([{ commits: [], max_columns: 0 }]);
		});
		await waitFor(() => {
			expect(toasts.items.map((t) => t.message)).toContain(
				"Could not save which refs are hidden",
			);
		});
	});

	it("does not push anything when nothing is hidden", async () => {
		render(BranchSidebar, { props: { repoPath: "/test/repo" } });

		await waitFor(() => {
			expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"set_ref_visibility",
			expect.anything(),
		);
	});
});
