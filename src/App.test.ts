import { invoke } from "@tauri-apps/api/core";
import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";

// Stub OffscreenCanvas for jsdom — text-measure.ts uses it via CommitGraph
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

if (typeof Element.prototype.scrollTo === "undefined") {
	Element.prototype.scrollTo = () => {};
}

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

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: vi.fn().mockReturnValue({
		setZoom: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		onResized: vi.fn().mockResolvedValue(() => {}),
		onMoved: vi.fn().mockResolvedValue(() => {}),
		onFocusChanged: vi.fn().mockResolvedValue(() => {}),
		isMaximized: vi.fn().mockResolvedValue(false),
		isFullscreen: vi.fn().mockResolvedValue(false),
		isFocused: vi.fn().mockResolvedValue(true),
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

vi.mock("sortablejs", () => {
	const mockInstance = { destroy: vi.fn(), option: vi.fn() };
	const MockSortable = vi.fn().mockImplementation(() => mockInstance);
	(MockSortable as unknown as Record<string, unknown>).create = vi
		.fn()
		.mockReturnValue(mockInstance);
	return { default: MockSortable };
});

const mockInvoke = vi.mocked(invoke);

const REPO_A = "/repo/A";
const REPO_B = "/repo/B";

const prefs: Record<string, unknown> = {};

function graphPathsRequested(): string[] {
	return mockInvoke.mock.calls
		.filter(([cmd]) => cmd === "get_commit_graph")
		.map(([, args]) => (args as { path: string }).path);
}

describe("App", () => {
	beforeEach(() => {
		for (const key of Object.keys(prefs)) delete prefs[key];
		prefs.open_tabs = [{ id: "tab-1", repoPath: REPO_A, repoName: "A" }];
		prefs.active_tab_id = "tab-1";
		prefs.recent_repos = [
			{ name: "A", path: REPO_A },
			{ name: "B", path: REPO_B },
		];

		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
			switch (cmd) {
				case "prefs_get":
					return Promise.resolve(prefs[(args as { key: string }).key] ?? null);
				case "prefs_set": {
					const { key, value } = args as { key: string; value: unknown };
					prefs[key] = value;
					return Promise.resolve(undefined);
				}
				case "validate_recent_path":
					return Promise.resolve(true);
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
					return Promise.resolve({ staged: 0, unstaged: 0, conflicted: 0 });
				case "check_undo_available":
					return Promise.resolve(true);
				case "undo_commit":
					return Promise.resolve({ subject: "repo A subject", body: null });
				case "list_stashes":
					return Promise.resolve([]);
				default:
					return Promise.resolve(undefined);
			}
		});
	});

	// Known flake: this test has expired its 1 008 ms `waitFor` deadline under
	// contention without the application being broken. If it fails, read TRUNK-62
	// (`backlog task 62 --plain`) before investigating — it records what is already
	// ruled out, including that raising this deadline is not the fix.
	it("loads the new repository's graph when a tab swaps repositories in place", async () => {
		const { getByText } = render(App);
		await waitFor(() => expect(graphPathsRequested()).toContain(REPO_A));

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "r", metaKey: true }),
		);
		const entry = await waitFor(() => getByText("B"));
		entry.click();

		await waitFor(() => expect(graphPathsRequested()).toContain(REPO_B));
	});

	it("drops a pending redo when a tab swaps repositories in place", async () => {
		const { getByLabelText, getByText } = render(App);
		await waitFor(() => expect(graphPathsRequested()).toContain(REPO_A));

		const undo = await waitFor(() => getByLabelText("Undo"));
		await waitFor(() => expect(undo).not.toBeDisabled());
		undo.click();
		await waitFor(() => expect(getByLabelText("Redo")).not.toBeDisabled());

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "r", metaKey: true }),
		);
		const entry = await waitFor(() => getByText("B"));
		entry.click();

		await waitFor(() => expect(getByLabelText("Redo")).toBeDisabled());
	});
});
