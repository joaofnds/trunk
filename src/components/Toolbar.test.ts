import { emit, listen } from "@tauri-apps/api/event";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { CHECKOUT_CONFLICT_MESSAGE } from "../lib/checkout.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import {
	createUndoRedoState,
	type UndoEntry,
} from "../lib/undo-redo.svelte.js";
import { setUpdateFrozen } from "../lib/updates-lifecycle.js";
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
}));

// Mock invoke module — safeInvoke for check_undo_available etc.
vi.mock("../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../lib/invoke.js")>()),
	safeInvoke: vi.fn().mockResolvedValue(false),
}));

function toasted(): { message: string; kind: string }[] {
	return toasts.items.map(({ message, kind }) => ({ message, kind }));
}

beforeEach(() => {
	vi.mocked(safeInvoke).mockReset();
	_resetToasts();
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Toolbar", () => {
	it("renders Pull button", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
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
				shownHeadOid: null,
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
				shownHeadOid: null,
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
				shownHeadOid: null,
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
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Redo" })).toBeInTheDocument();
	});

	it("admits one undo-state read and one catch-up while repo events continue", async () => {
		const scheduler = new FakeScheduler();
		const first = deferred<boolean>();
		let undoReads = 0;
		let repoChanged: ((event: { payload: unknown }) => void) | undefined;
		vi.mocked(listen).mockImplementation(async (name, callback) => {
			if (name === "repo-changed") {
				repoChanged = callback as (event: { payload: unknown }) => void;
			}
			return () => {};
		});
		vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
			if (cmd === "check_undo_available") {
				undoReads += 1;
				return undoReads === 1 ? first.promise : Promise.resolve(false);
			}
			if (cmd === "head_oid") return Promise.resolve(null);
			return Promise.resolve(undefined);
		});

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
			context: new Map([[SCHEDULER, scheduler]]),
		});
		await waitFor(() => expect(undoReads).toBe(1));

		for (let index = 0; index < 5; index += 1) {
			repoChanged?.({ payload: { repo: "/test/repo", paths: [] } });
			scheduler.advanceBy(200);
		}
		expect(undoReads).toBe(1);

		first.resolve(false);
		await waitFor(() => expect(scheduler.pending).toBe(1));
		scheduler.advanceBy(200);
		await waitFor(() => expect(undoReads).toBe(2));
	});

	it("disables Pull and Push when remote operation is running", () => {
		const remoteState = makeRemoteState();
		remoteState.isRunning = true;

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState,
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
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
				shownHeadOid: null,
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
			{ undoneOid: "c2", headOid: "abc123", repoPath: "/test/repo" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: null,
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
			{ undoneOid: "c2", headOid: "abc123", repoPath: "/test/repo" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: null,
				reviewActive: false,
			},
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled(),
		);
	});

	// A tab can be pointed at another repository without remounting, and two
	// clones share every oid. Position alone would call that a match and move the
	// incoming repository's branch onto the outgoing one's undone commit.
	it("withholds Redo in a different repository sitting at the same commit", async () => {
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) =>
			cmd === "head_oid" ? "abc123" : false,
		);
		const undoRedo = makeUndoRedo();
		undoRedo.state.redoStack = [
			{ undoneOid: "c2", headOid: "abc123", repoPath: "/a/clone" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/another/clone",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: null,
				reviewActive: false,
			},
		});

		// Redo starts disabled and the poll is what could turn it on, so waiting
		// for the answer to land is what makes this assertion mean anything.
		await waitFor(() =>
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("head_oid", {
				path: "/another/clone",
			}),
		);
		await tick();
		expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
	});

	it("sends the entry's position and repository on redo, so the backend can refuse a stale one", async () => {
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) =>
			cmd === "head_oid" ? "abc123" : false,
		);
		const undoRedo = makeUndoRedo();
		undoRedo.state.redoStack = [
			{
				undoneOid: "c2",
				headOid: "abc123",
				repoPath: "/test/repo",
			},
		];
		undoRedo.pop.mockReturnValue(undoRedo.state.redoStack[0]);

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: null,
				reviewActive: false,
			},
		});

		const redoBtn = await waitFor(() => {
			const btn = screen.getByRole("button", { name: "Redo" });
			expect(btn).toBeEnabled();
			return btn;
		});
		await fireEvent.click(redoBtn);

		await waitFor(() =>
			expect(safeInvoke).toHaveBeenCalledWith("redo_commit", {
				path: "/test/repo",
				undoneOid: "c2",
				expectedHeadOid: "abc123",
				expectedRepoPath: "/test/repo",
			}),
		);
	});

	/** Render a Toolbar holding one redo entry whose `redo_commit` fails with
	 *  `error`, click Redo, and hand back the store. */
	async function redoFailingWith(error: { code: string; message: string }) {
		_resetToasts();
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) => {
			if (cmd === "redo_commit") throw error;
			return cmd === "head_oid" ? "abc123" : false;
		});
		const undoRedo = createUndoRedoState();
		undoRedo.push({
			undoneOid: "c2",
			headOid: "abc123",
			repoPath: "/test/repo",
		});
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		const redoBtn = await waitFor(() => {
			const btn = screen.getByRole("button", { name: "Redo" });
			expect(btn).toBeEnabled();
			return btn;
		});
		await fireEvent.click(redoBtn);
		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: error.message,
				kind: "error",
			}),
		);
		return undoRedo;
	}

	it("shows git's whole output and keeps the redo when git fails it", async () => {
		const undoRedo = await redoFailingWith({
			code: "redo_error",
			message:
				"fatal: Unable to create '/test/repo/.git/index.lock': File exists.",
		});

		expect(undoRedo.state.redoStack).toEqual([
			{ undoneOid: "c2", headOid: "abc123", repoPath: "/test/repo" },
		]);
		expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
	});

	it("withdraws a redo whose commit the repository no longer has", async () => {
		const undoRedo = await redoFailingWith({
			code: "redo_missing",
			message: "The commit this redo restores is no longer in the repository",
		});

		expect(undoRedo.state.redoStack).toEqual([]);
		expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
	});

	it("emits review-toggle on click", async () => {
		const { emit } = await import("@tauri-apps/api/event");
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
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
				shownHeadOid: null,
				reviewActive: true,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn).toHaveAttribute("aria-pressed", "true");
	});

	it("shows inactive state when a diff is showing inside an active review", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: true,
				reviewPanelShowing: false,
			},
		});
		const btn = screen.getByRole("button", { name: /Review/ });
		expect(btn).toHaveAttribute("aria-pressed", "false");
	});

	it("emits review-show-panel when clicked while a diff is showing in review", async () => {
		const { emit } = await import("@tauri-apps/api/event");
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
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
				shownHeadOid: null,
				reviewActive: true,
				reviewPanelShowing: true,
			},
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		await fireEvent.click(reviewBtn);
		expect(vi.mocked(emit)).toHaveBeenCalledWith("review-toggle");
	});

	it("shows the current-view count on the review filter badge", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
				viewCommentCount: 3,
			},
		});
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("hides the review filter badge when the view count is zero", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
				viewCommentCount: 0,
			},
		});
		const threadsButton = screen.getByRole("button", {
			name: "Hide review threads",
		});
		expect(threadsButton.querySelector(".toolbar-badge")).toBeNull();
	});

	it("shows the review-comment count on the Review button badge", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
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
				shownHeadOid: null,
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
				shownHeadOid: null,
				reviewActive: false,
				viewCommentCount: 2,
				reviewCommentCount: 4,
			},
		});
		const threadsButton = screen.getByRole("button", {
			name: "Hide review threads",
		});
		const reviewBtn = screen.getByRole("button", { name: /Review/ });
		expect(threadsButton.querySelector(".toolbar-badge")?.textContent).toBe(
			"2",
		);
		expect(reviewBtn.querySelector(".toolbar-badge")?.textContent).toBe("4");
	});

	it("keeps badge accessible names neutral when tone is only visual priority", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
				viewCommentCount: 2,
				viewCommentTone: "open",
				reviewCommentCount: 2,
				reviewCommentTone: "addressed",
			},
		});

		expect(
			screen.getByRole("img", { name: "2 review comments in this view" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: "2 review comments in this review" }),
		).toBeInTheDocument();
	});

	it("paints the toggle in the accent sleeve while threads show", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		const threadsButton = screen.getByRole("button", {
			name: "Hide review threads",
		});

		expect(threadsButton.parentElement).toHaveClass(
			"bg-accent-bg",
			"ring-accent-border",
		);
		expect(threadsButton).toHaveAttribute("aria-pressed", "true");
	});

	it("frames the toggle alone, in neutral, when review threads are hidden", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
				reviewThreadsHidden: true,
			},
		});
		const threadsButton = screen.getByRole("button", {
			name: "Show review threads",
		});

		expect(threadsButton.parentElement).toHaveClass("ring-border");
		expect(threadsButton.parentElement).not.toHaveClass("bg-accent-bg");
	});

	it("presses the toggle off when review threads are hidden", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
				reviewThreadsHidden: true,
			},
		});

		expect(
			screen.getByRole("button", { name: "Show review threads" }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it.each([
		{ hidden: false, press: "Hide review threads", asks: true },
		{ hidden: true, press: "Show review threads", asks: false },
	])(
		"asks for hidden $asks when $press is pressed",
		async ({ hidden, press, asks }) => {
			const onreviewthreadshiddenchange = vi.fn();
			render(Toolbar, {
				props: {
					repoPath: "/test/repo",
					remoteState: makeRemoteState(),
					undoRedo: makeUndoRedo(),
					shownHeadOid: null,
					reviewActive: false,
					reviewThreadsHidden: hidden,
					onreviewthreadshiddenchange,
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: press }));

			expect(onreviewthreadshiddenchange).toHaveBeenLastCalledWith(asks);
		},
	);
});

describe("Toolbar remote failure feedback", () => {
	const mockInvoke = vi.mocked(safeInvoke);

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
				shownHeadOid: null,
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
		expect(toasted()).toEqual([]);
	});

	it("still shows a success toast on a successful push", async () => {
		mockInvoke.mockResolvedValue(false);
		const remoteState = makeRemoteState();

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState,
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Push" }));

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "Pushed successfully",
				kind: "success",
			}),
		);
		expect(remoteState.error).toBeNull();
	});
});

describe("Toolbar stash", () => {
	const mockInvoke = vi.mocked(safeInvoke);

	// TRUNK-231: with nothing staged the backend names staging as the next step. A bare
	// "Failed to create stash" tells the user nothing they can act on.
	it("shows the backend's stage-first message when nothing is staged", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "stash_save"
				? Promise.reject({
						code: "nothing_to_stash",
						message: "Nothing to stash — stage changes first.",
					})
				: Promise.resolve(false),
		);

		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Stash" }));

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "Nothing to stash — stage changes first.",
				kind: "error",
			}),
		);
	});

	it("pops one stash when Pop is pressed twice", async () => {
		let pops = 0;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_stashes") return Promise.resolve([{ oid: "stash-0" }]);
			if (cmd === "stash_pop") {
				pops += 1;
				return deferred<never>().promise;
			}
			return Promise.resolve(false);
		});
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		const pop = screen.getByRole("button", { name: "Pop" });

		await fireEvent.click(pop);
		await waitFor(() => expect(pops).toBe(1));
		await fireEvent.click(pop);

		expect(pops).toBe(1);
	});

	it("pops again once the first pop settles", async () => {
		let pops = 0;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_stashes") return Promise.resolve([{ oid: "stash-0" }]);
			if (cmd === "stash_pop") {
				pops += 1;
				return Promise.resolve(null);
			}
			return Promise.resolve(false);
		});
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		const pop = screen.getByRole("button", { name: "Pop" });
		await fireEvent.click(pop);
		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "Stash popped",
				kind: "success",
			}),
		);

		await fireEvent.click(pop);

		await waitFor(() => expect(pops).toBe(2));
	});

	it("shows why the stash would not apply", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_stashes") return Promise.resolve([{ oid: "stash-0" }]);
			if (cmd === "stash_pop")
				return Promise.reject({
					code: "conflict_state",
					message: "The stash conflicts with your changes.",
				});
			return Promise.resolve(false);
		});
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Pop" }));

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "The stash conflicts with your changes.",
				kind: "error",
			}),
		);
	});
});

describe("Toolbar undo", () => {
	const mockInvoke = vi.mocked(safeInvoke);

	let view: ReturnType<typeof render<typeof Toolbar>>;
	let undoRedo: ReturnType<typeof makeUndoRedo>;

	function renderUndoable(undoCommit: () => Promise<unknown>) {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "check_undo_available") return Promise.resolve(true);
			if (cmd === "head_oid") return Promise.resolve("head-commit");
			if (cmd === "undo_commit") return undoCommit();
			return Promise.resolve(null);
		});
		undoRedo = makeUndoRedo();
		view = render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: "head-commit",
				reviewActive: false,
			},
		});
		return screen.getByRole("button", { name: "Undo" });
	}

	it("aims Undo at the commit the graph shows, not where HEAD has moved since", async () => {
		const undo = renderUndoable(() =>
			Promise.resolve({ head_oid: "parent", undone_oid: "head-commit" }),
		);
		await waitFor(() => expect(undo).toBeEnabled());
		// A pull lands a commit the graph has not drawn yet.
		const earlier = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation((cmd, args) =>
			cmd === "head_oid"
				? Promise.resolve("pulled")
				: (earlier?.(cmd, args) ?? Promise.resolve(null)),
		);

		await fireEvent.click(undo);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("undo_commit", {
				path: "/test/repo",
				expectedHeadOid: "head-commit",
			}),
		);
	});

	it("aims Undo at a commit as soon as the graph shows it", async () => {
		const undo = renderUndoable(() =>
			Promise.resolve({ head_oid: "head-commit", undone_oid: "revert" }),
		);
		await waitFor(() => expect(undo).toBeEnabled());
		await view.rerender({ shownHeadOid: "revert" });

		await fireEvent.click(undo);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("undo_commit", {
				path: "/test/repo",
				expectedHeadOid: "revert",
			}),
		);
	});

	it("offers no Undo before the graph shows a HEAD", async () => {
		const undo = renderUndoable(() => deferred<never>().promise);
		await waitFor(() => expect(undo).toBeEnabled());

		await view.rerender({ shownHeadOid: null });

		expect(undo).toBeDisabled();
	});

	it("undoes one commit when Undo is pressed twice", async () => {
		let undos = 0;
		const undo = renderUndoable(() => {
			undos += 1;
			return deferred<never>().promise;
		});
		await waitFor(() => expect(undo).toBeEnabled());

		await fireEvent.click(undo);
		await fireEvent.click(undo);

		expect(undos).toBe(1);
	});

	it("undoes again once the first undo settles", async () => {
		let undos = 0;
		const undo = renderUndoable(() => {
			undos += 1;
			return Promise.reject({ code: "git_error", message: "not yet" });
		});
		await waitFor(() => expect(undo).toBeEnabled());
		await fireEvent.click(undo);
		await waitFor(() =>
			expect(toasted()).toContainEqual({ message: "not yet", kind: "error" }),
		);

		await fireEvent.click(undo);

		await waitFor(() => expect(undos).toBe(2));
	});

	it("keeps Undo live in another repository while one undoes", async () => {
		const undo = renderUndoable(() => deferred<never>().promise);
		await waitFor(() => expect(undo).toBeEnabled());
		await fireEvent.click(undo);

		await view.rerender({ repoPath: "/other/repo" });

		await waitFor(() => expect(undo).toBeEnabled());
	});

	it("records an undo under the repository it ran in", async () => {
		const reply = deferred<unknown>();
		const undo = renderUndoable(() => reply.promise);
		await waitFor(() => expect(undo).toBeEnabled());
		await fireEvent.click(undo);
		await view.rerender({ repoPath: "/other/repo" });

		reply.resolve({
			head_oid: "parent",
			undone_oid: "undone",
		});

		await waitFor(() =>
			expect(undoRedo.push).toHaveBeenCalledWith({
				undoneOid: "undone",
				headOid: "parent",
				repoPath: "/test/repo",
			}),
		);
	});

	it("tells the user why the undo failed", async () => {
		const undo = renderUndoable(() =>
			Promise.reject({ code: "git_error", message: "HEAD has no parent" }),
		);
		await waitFor(() => expect(undo).toBeEnabled());

		await fireEvent.click(undo);

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "HEAD has no parent",
				kind: "error",
			}),
		);
	});
});

describe("Toolbar undo and redo shortcuts", () => {
	const mockInvoke = vi.mocked(safeInvoke);

	/** A branch's linear history, oldest first, with HEAD on one commit. It answers
	 *  the toolbar's undo and redo commands as the backend does, refusals included,
	 *  and like the backend it announces a finished undo or redo as a completed
	 *  repository change before replying. `hold()` keeps the next undo or redo
	 *  running until the returned release is called. */
	function linearHistory(...commits: string[]) {
		const repoChanged: ((event: { payload: unknown }) => void)[] = [];
		let held: Promise<void> | null = null;
		const history = {
			head: commits.length - 1,
			refused: [] as string[],
			/** Redraws the graph the toolbar reads HEAD from. */
			repaint: (_tip: string) => {},
			get tip() {
				return commits[history.head];
			},
			hold() {
				let release!: () => void;
				held = new Promise<void>((done) => {
					release = done;
				});
				return release;
			},
		};

		function announce() {
			const payload = {
				repo: "/test/repo",
				paths: [],
				command_completed: true,
			};
			for (const callback of repoChanged) callback({ payload });
			history.repaint(history.tip);
		}

		async function undoCommit(expectedHeadOid: string) {
			if (expectedHeadOid !== history.tip) {
				history.refused.push(`undo from ${history.tip}`);
				throw new Error("HEAD moved");
			}
			if (history.head === 0) {
				history.refused.push("undo of a root commit");
				throw new Error("Cannot undo the root commit");
			}
			const undone = history.tip;
			history.head -= 1;
			announce();
			return { head_oid: history.tip, undone_oid: undone };
		}

		async function redoCommit(undoneOid: string, expectedHeadOid: string) {
			if (expectedHeadOid !== history.tip) {
				history.refused.push(`redo from ${history.tip}`);
				throw new Error("HEAD moved");
			}
			history.head = commits.indexOf(undoneOid);
			announce();
			return null;
		}

		async function afterHold<T>(step: () => Promise<T>) {
			const wait = held;
			held = null;
			if (wait) await wait;
			return step();
		}

		vi.mocked(listen).mockImplementation(async (name, callback) => {
			if (name === "repo-changed") {
				repoChanged.push(callback as (event: { payload: unknown }) => void);
			}
			return () => {};
		});
		mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
			switch (cmd) {
				case "check_undo_available":
					return Promise.resolve(history.head > 0);
				case "head_oid":
					return Promise.resolve(history.tip);
				case "undo_commit": {
					const { expectedHeadOid } = args as { expectedHeadOid: string };
					return afterHold(() => undoCommit(expectedHeadOid));
				}
				case "redo_commit": {
					const { undoneOid, expectedHeadOid } = args as {
						undoneOid: string;
						expectedHeadOid: string;
					};
					return afterHold(() => redoCommit(undoneOid, expectedHeadOid));
				}
				default:
					return Promise.resolve(null);
			}
		});
		shown = history;
		return history;
	}

	let shown: ReturnType<typeof linearHistory>;

	function renderToolbar(undoRedo = createUndoRedoState()) {
		const view = render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo,
				shownHeadOid: shown.tip,
				reviewActive: false,
			},
		});
		shown.repaint = (tip) => void view.rerender({ shownHeadOid: tip });
		return {
			undo: screen.getByRole("button", { name: "Undo" }),
			redo: screen.getByRole("button", { name: "Redo" }),
		};
	}

	function press(
		target: Element,
		chord: { key: string; shiftKey?: boolean; repeat?: boolean },
		modifier: "metaKey" | "ctrlKey" = "metaKey",
	) {
		return fireEvent.keyDown(target, { ...chord, [modifier]: true });
	}

	const cmdZ = { key: "z" };
	const cmdShiftZ = { key: "Z", shiftKey: true };

	it("undoes the last commit on Cmd+Z", async () => {
		const history = linearHistory("root", "parent", "tip");
		const { undo } = renderToolbar();
		await waitFor(() => expect(undo).toBeEnabled());

		const notCancelled = await press(document.body, cmdZ);

		expect(notCancelled).toBe(false);
		await waitFor(() => expect(history.tip).toBe("parent"));
	});

	it("redoes the undone commit on Cmd+Shift+Z", async () => {
		const history = linearHistory("root", "parent", "tip");
		const { undo, redo } = renderToolbar();
		await waitFor(() => expect(undo).toBeEnabled());
		await press(document.body, cmdZ);
		await waitFor(() => expect(redo).toBeEnabled());

		await press(document.body, cmdShiftZ);

		await waitFor(() => expect(history.tip).toBe("tip"));
	});

	it("undoes on Ctrl+Z outside macOS", async () => {
		const history = linearHistory("root", "parent", "tip");
		const { undo } = renderToolbar();
		await waitFor(() => expect(undo).toBeEnabled());

		await press(document.body, cmdZ, "ctrlKey");

		await waitFor(() => expect(history.tip).toBe("parent"));
	});

	it("stops offering Undo once it reaches the root commit", async () => {
		linearHistory("root", "tip");
		const { undo } = renderToolbar();
		await waitFor(() => expect(undo).toBeEnabled());

		await press(document.body, cmdZ);

		await waitFor(() => expect(undo).toBeDisabled());
	});

	it("redoes a second undone commit right after the first redo lands", async () => {
		const history = linearHistory("root", "one", "two", "three");
		const { undo, redo } = renderToolbar();
		await waitFor(() => expect(undo).toBeEnabled());
		await press(document.body, cmdZ);
		await waitFor(() => expect(history.tip).toBe("two"));
		await press(document.body, cmdZ);
		await waitFor(() => expect(history.tip).toBe("one"));
		await waitFor(() => expect(redo).toBeEnabled());
		await press(document.body, cmdShiftZ);
		await waitFor(() => expect(history.tip).toBe("two"));

		await waitFor(() => expect(redo).toBeEnabled());
		await press(document.body, cmdShiftZ);

		await waitFor(() => expect(history.tip).toBe("three"));
		expect(history.refused).toEqual([]);
	});

	describe("when on macOS", () => {
		beforeEach(() => {
			const platform = vi
				.spyOn(navigator, "platform", "get")
				.mockReturnValue("MacIntel");
			onTestFinished(() => platform.mockRestore());
		});

		it("undoes the last commit on Cmd+Z", async () => {
			const history = linearHistory("root", "parent", "tip");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());

			await press(document.body, cmdZ);

			await waitFor(() => expect(history.tip).toBe("parent"));
		});

		it("leaves Ctrl+Z alone", async () => {
			const history = linearHistory("root", "parent", "tip");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());

			const notCancelled = await press(document.body, cmdZ, "ctrlKey");

			expect(notCancelled).toBe(true);
			expect(history.tip).toBe("tip");
		});
	});

	describe("when the keys belong to something else", () => {
		it("leaves Cmd+Z to the text field that has focus", async () => {
			const history = linearHistory("root", "parent", "tip");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			const field = document.body.appendChild(document.createElement("input"));
			onTestFinished(() => field.remove());
			field.focus();

			const notCancelled = await press(field, cmdZ);

			expect(notCancelled).toBe(true);
			expect(history.tip).toBe("tip");
		});

		it("leaves Cmd+Z alone while a dialog is open", async () => {
			const history = linearHistory("root", "parent", "tip");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			const dialog = document.body.appendChild(
				document.createElement("dialog"),
			);
			onTestFinished(() => dialog.remove());
			dialog.setAttribute("open", "");

			const notCancelled = await press(document.body, cmdZ);

			expect(notCancelled).toBe(true);
			expect(history.tip).toBe("tip");
		});

		it("leaves Cmd+Z alone while an update freezes the app", async () => {
			const history = linearHistory("root", "parent", "tip");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			setUpdateFrozen(true);
			onTestFinished(() => setUpdateFrozen(false));

			const notCancelled = await press(document.body, cmdZ);

			expect(notCancelled).toBe(true);
			expect(history.tip).toBe("tip");
		});
	});

	describe("when the history cannot take the step", () => {
		it("does nothing on Cmd+Z at the root commit", async () => {
			const history = linearHistory("root");
			renderToolbar();

			await press(document.body, cmdZ);

			expect(history.refused).toEqual([]);
		});

		it("does nothing on Cmd+Shift+Z when the redo belongs elsewhere", async () => {
			const history = linearHistory("root", "parent");
			const undoRedo = createUndoRedoState();
			undoRedo.push({
				undoneOid: "tip",
				headOid: "other",
				repoPath: "/test/repo",
			});
			const { undo } = renderToolbar(undoRedo);
			await waitFor(() => expect(undo).toBeEnabled());

			await press(document.body, cmdShiftZ);

			expect(history.refused).toEqual([]);
		});

		it("takes one step for a held Cmd+Z", async () => {
			const history = linearHistory("root", "one", "two");
			const { undo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			await press(document.body, cmdZ);
			await waitFor(() => expect(history.tip).toBe("one"));
			await waitFor(() => expect(undo).toBeEnabled());

			const notCancelled = await press(document.body, {
				...cmdZ,
				repeat: true,
			});

			expect(notCancelled).toBe(false);
			expect(history.tip).toBe("one");
		});

		it("ignores Cmd+Shift+Z while an undo is still running", async () => {
			const history = linearHistory("root", "one", "two");
			const { undo, redo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			await press(document.body, cmdZ);
			await waitFor(() => expect(redo).toBeEnabled());
			const release = history.hold();
			await press(document.body, cmdZ);

			await press(document.body, cmdShiftZ);
			release();

			await waitFor(() => expect(history.tip).toBe("root"));
			await waitFor(() => expect(redo).toBeEnabled());
			expect(history.refused).toEqual([]);
		});

		it("ignores Cmd+Z while a redo is still running", async () => {
			const history = linearHistory("root", "one", "two");
			const { undo, redo } = renderToolbar();
			await waitFor(() => expect(undo).toBeEnabled());
			await press(document.body, cmdZ);
			await waitFor(() => expect(redo).toBeEnabled());
			const release = history.hold();
			await press(document.body, cmdShiftZ);

			await press(document.body, cmdZ);
			release();

			await waitFor(() => expect(history.tip).toBe("two"));
			expect(history.refused).toEqual([]);
		});
	});
});

describe("Toolbar branch creation", () => {
	const mockInvoke = vi.mocked(safeInvoke);

	async function createBranch(name: string, answer: Promise<unknown>) {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "create_branch" ? answer : Promise.resolve(false),
		);
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				shownHeadOid: null,
				reviewActive: false,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Branch" }));
		await fireEvent.input(screen.getByLabelText(/Branch name/), {
			target: { value: name },
		});
		await fireEvent.click(screen.getByRole("button", { name: "OK" }));
	}

	it("toasts the checkout of the new branch", async () => {
		await createBranch("feature", Promise.resolve(undefined));

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: "Checked out feature",
				kind: "success",
			}),
		);
	});

	// TRUNK-277: a refused creation writes nothing, so a success toast would be a lie.
	it("shows the conflict message when uncommitted changes conflict", async () => {
		await createBranch(
			"feature",
			Promise.reject({ code: "dirty_workdir", message: "conflict" }),
		);

		await waitFor(() =>
			expect(toasted()).toContainEqual({
				message: CHECKOUT_CONFLICT_MESSAGE,
				kind: "error",
			}),
		);
	});

	it("names the branch that already holds the name", async () => {
		const message =
			"A branch named 'feat' already exists, so 'feat/x' cannot be created";
		await createBranch(
			"feat/x",
			Promise.reject({ code: "branch_exists", message }),
		);

		await waitFor(() =>
			expect(toasted()).toContainEqual({ message: message, kind: "error" }),
		);
	});
});
