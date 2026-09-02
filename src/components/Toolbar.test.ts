import { emit, listen } from "@tauri-apps/api/event";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "../lib/invoke.js";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type { UndoEntry } from "../lib/undo-redo.svelte.js";
import Toolbar from "./Toolbar.svelte";

// All Tauri module mocks — declared locally (NOT via ../__tests__/helpers/tauri-mock)
// for proper vi.mock hoisting before Toolbar.svelte's static imports resolve.
// The new Review-button tests assert on `emit` identity, which requires the
// mocked event module to be the SAME instance Toolbar.svelte sees at import time
// — a guarantee the shared helper cannot provide (its vi.mock runs at the helper
// file's import time, AFTER Toolbar.svelte has already resolved its imports).
//
// Includes:
//   listen: vi.fn().mockResolvedValue(() => {})
//   emit: vi.fn().mockResolvedValue(undefined)
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
	message: vi.fn().mockResolvedValue(undefined),
}));

// Mock invoke module — safeInvoke for check_undo_available etc.
vi.mock("../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../lib/invoke.js")>()),
	safeInvoke: vi.fn().mockResolvedValue(false),
}));

// Mock toast module
vi.mock("../lib/toast.svelte.js", () => ({
	showToast: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(showToast).mockReset();
	vi.mocked(emit).mockReset();
	vi.mocked(listen)
		.mockReset()
		.mockResolvedValue(() => {});
});

function makeRemoteState(): RemoteState {
	return createRemoteState();
}

function makeUndoRedo() {
	return {
		state: { redoStack: [] as UndoEntry[] },
		push: vi.fn(),
		pop: vi.fn(),
		clear: vi.fn(),
	};
}

describe("Toolbar", () => {
	it("renders Pull button", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Pull" })).toBeInTheDocument();
	});

	it("renders Push button", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
	});

	it("renders Branch button", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Branch" })).toBeInTheDocument();
	});

	it("renders Stash and Pop buttons", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Stash" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Pop" })).toBeInTheDocument();
	});

	it("renders Undo and Redo buttons", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Redo" })).toBeInTheDocument();
	});

	it("disables Pull and Push when remote operation is running", () => {
		const remoteState = makeRemoteState();
		remoteState.isRunning = true;

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState,
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});

		const pullBtn = screen.getByRole("button", { name: "Pull" });
		const pushBtn = screen.getByRole("button", { name: "Push" });
		expect(pullBtn).toBeDisabled();
		expect(pushBtn).toBeDisabled();
	});

	it("disables Redo when redo stack is empty", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(), // empty redoStack
				reviewActive: false,
			},
		});

		const redoBtn = screen.getByRole("button", { name: "Redo" });
		expect(redoBtn).toBeDisabled();
	});

	it("offers Redo while HEAD is still where the undo left it", async () => {
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) =>
			cmd === "head_oid" ? "abc123" : false,
		);
		const undoRedo = makeUndoRedo();
		undoRedo.state.redoStack = [
			{ subject: "C2", body: null, headOid: "abc123" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				reviewActive: false,
			},
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled(),
		);
	});

	it("withholds Redo once HEAD has moved off the position the entry names", async () => {
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) =>
			cmd === "head_oid" ? "moved-elsewhere" : false,
		);
		const undoRedo = makeUndoRedo();
		undoRedo.state.redoStack = [
			{ subject: "C2", body: null, headOid: "abc123" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				reviewActive: false,
			},
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled(),
		);
	});

	it("emits review-toggle on click", async () => {
		const { emit } = await import("@tauri-apps/api/event");
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		await fireEvent.click(reviewBtn);
		expect(vi.mocked(emit)).toHaveBeenCalledWith("review-toggle");
	});

	it("shows active state when reviewActive is true", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: true,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn).toHaveClass("toolbar-btn-active");
		expect(btn).toHaveAttribute("aria-pressed", "true");
	});

	it("shows inactive state when a diff is showing inside an active review", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: true,
				reviewPanelShowing: false,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn).not.toHaveClass("toolbar-btn-active");
		expect(btn).toHaveAttribute("aria-pressed", "false");
	});

	it("emits review-show-panel when clicked while a diff is showing in review", async () => {
		const { emit } = await import("@tauri-apps/api/event");
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: true,
				reviewPanelShowing: false,
			},
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		await fireEvent.click(reviewBtn);
		expect(vi.mocked(emit)).toHaveBeenCalledWith("review-show-panel");
	});

	it("emits review-toggle when clicked while the review panel is showing", async () => {
		const { emit } = await import("@tauri-apps/api/event");
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: true,
				reviewPanelShowing: true,
			},
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		await fireEvent.click(reviewBtn);
		expect(vi.mocked(emit)).toHaveBeenCalledWith("review-toggle");
	});

	it("shows the inline-comment count on the toggle badge", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				inlineCommentCount: 3,
			},
		});
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("hides the inline-comment badge when count is zero", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				inlineCommentCount: 0,
			},
		});
		const btn = screen.getByRole("button", {
			name: /Toggle inline comments/,
		});
		expect(btn.querySelector(".toolbar-badge")).toBeNull();
	});

	it("shows the review-comment count on the Review button badge", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewCommentCount: 4,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn.querySelector(".toolbar-badge")?.textContent).toBe("4");
	});

	it("hides the Review button badge when review-comment count is zero", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewCommentCount: 0,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn.querySelector(".toolbar-badge")).toBeNull();
	});

	it("renders distinct badges for the view and total counts", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				inlineCommentCount: 2,
				reviewCommentCount: 4,
			},
		});
		const toggleBtn = screen.getByRole("button", {
			name: /Toggle inline comments/,
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		expect(toggleBtn.querySelector(".toolbar-badge")?.textContent).toBe("2");
		expect(reviewBtn.querySelector(".toolbar-badge")?.textContent).toBe("4");
	});

	it("fires ontoggleinlinecomments when the toggle is clicked", async () => {
		const ontoggleinlinecomments = vi.fn();
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				ontoggleinlinecomments,
			},
		});
		const btn = screen.getByRole("button", {
			name: /Toggle inline comments/,
		});
		await fireEvent.click(btn);
		expect(ontoggleinlinecomments).toHaveBeenCalledTimes(1);
	});

	it("reflects active state from showInlineComments", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				showInlineComments: true,
			},
		});
		const btn = screen.getByRole("button", {
			name: /Toggle inline comments/,
		});
		expect(btn).toHaveClass("toolbar-btn-toggle-on");
		expect(btn).toHaveAttribute("aria-pressed", "true");
	});

	it("shows inactive state when showInlineComments is false", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				showInlineComments: false,
			},
		});
		const btn = screen.getByRole("button", {
			name: /Toggle inline comments/,
		});
		expect(btn).not.toHaveClass("toolbar-btn-toggle-on");
		expect(btn).toHaveAttribute("aria-pressed", "false");
	});
});

describe("Toolbar remote failure feedback", () => {
	const mockInvoke = vi.mocked(safeInvoke);
	const mockToast = vi.mocked(showToast);

	it("records a failed push on remoteState.error without an auto-dismissing toast", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "git_push"
				? Promise.reject({ code: "non_fast_forward", message: "rejected" })
				: Promise.resolve(false),
		);
		const remoteState = makeRemoteState();

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState,
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Push" }));

		await waitFor(() =>
			expect(remoteState.error).toEqual({
				code: "non_fast_forward",
				message: "rejected",
			}),
		);
		expect(mockToast).not.toHaveBeenCalled();
	});

	it("still shows a success toast on a successful push", async () => {
		mockInvoke.mockResolvedValue(false);
		const remoteState = makeRemoteState();

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState,
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Push" }));

		await waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith("Pushed successfully", "success"),
		);
		expect(remoteState.error).toBeNull();
	});
});
