import { emit, listen } from "@tauri-apps/api/event";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { showToast } from "../lib/toast.svelte.js";
import type { UndoEntry } from "../lib/undo-redo.svelte.js";
import Toolbar, { reviewFilterSlide } from "./Toolbar.svelte";

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function injectedStyleRule(
	selectorIncludes: string[],
	selectorExcludes: string[] = [],
): CSSStyleRule {
	for (const sheet of Array.from(document.styleSheets)) {
		for (const rule of Array.from(sheet.cssRules)) {
			if (
				rule instanceof CSSStyleRule &&
				rule.selectorText
					.split(",")
					.some(
						(selector) =>
							selectorIncludes.every((part) => selector.includes(part)) &&
							selectorExcludes.every((part) => !selector.includes(part)),
					)
			) {
				return rule;
			}
		}
	}

	throw new Error(
		`no style rule found including ${selectorIncludes.join(", ")}`,
	);
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

	it("admits one undo-state read and one catch-up while repo events continue", async () => {
		const scheduler = new FakeScheduler();
		const first = deferred<boolean>();
		let undoReads = 0;
		let repoChanged: ((event: { payload: string }) => void) | undefined;
		vi.mocked(listen).mockImplementation(async (name, callback) => {
			if (name === "repo-changed") {
				repoChanged = callback as (event: { payload: string }) => void;
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
				reviewActive: false,
			},
			context: new Map([[SCHEDULER, scheduler]]),
		});
		await waitFor(() => expect(undoReads).toBe(1));

		for (let index = 0; index < 5; index += 1) {
			repoChanged?.({ payload: "/test/repo" });
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
			{ subject: "C2", body: null, headOid: "abc123", repoPath: "/test/repo" },
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
			{ subject: "C2", body: null, headOid: "abc123", repoPath: "/test/repo" },
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

	// A tab can be pointed at another repository without remounting, and two
	// clones share every oid. Position alone would call that a match and commit
	// the outgoing repository's message into the incoming one.
	it("withholds Redo in a different repository sitting at the same commit", async () => {
		vi.mocked(safeInvoke).mockImplementation(async (cmd: string) =>
			cmd === "head_oid" ? "abc123" : false,
		);
		const undoRedo = makeUndoRedo();
		undoRedo.state.redoStack = [
			{ subject: "C2", body: null, headOid: "abc123", repoPath: "/a/clone" },
		];

		render(Toolbar, {
			props: {
				repoPath: "/another/clone",
				remoteState: makeRemoteState(),
				undoRedo,
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
				subject: "C2",
				body: "desc",
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
				subject: "C2",
				body: "desc",
				expectedHeadOid: "abc123",
				expectedRepoPath: "/test/repo",
			}),
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

	it("shows the current-view count on the review filter badge", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
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
				reviewActive: false,
				viewCommentCount: 2,
				viewCommentTone: "open",
				reviewCommentCount: 2,
				reviewCommentTone: "addressed",
			},
		});

		expect(
			screen.getByLabelText("2 review comments in this view"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("2 review comments in this review"),
		).toBeInTheDocument();
	});

	it("fires onreviewfilterchange when the filter changes", async () => {
		const onreviewfilterchange = vi.fn();
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				onreviewfilterchange,
			},
		});
		const select = screen.getByRole("combobox", {
			name: "Review filter selection",
		});
		await fireEvent.change(select, { target: { value: "done" } });
		expect(onreviewfilterchange).toHaveBeenCalledWith("done");
	});

	it("reflects the selected review filter", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewFilter: "addressed",
			},
		});
		expect(
			screen.getByRole("combobox", { name: "Review filter selection" }),
		).toHaveValue("addressed");
	});

	it("renders the filter selector before the review threads toggle in DOM order", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});

		expect(
			screen.getByRole("combobox", { name: "Review filter selection" }),
		).toAppearBefore(
			screen.getByRole("button", { name: "Hide review threads" }),
		);
	});

	it("groups the active filter and toggle in one container", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		const select = screen.getByRole("combobox", {
			name: "Review filter selection",
		});
		const threadsButton = screen.getByRole("button", {
			name: "Hide review threads",
		});

		expect(threadsButton.parentElement).toContainElement(select);
		expect(threadsButton.parentElement).toHaveClass(
			"review-filter-control-active",
		);
	});

	it("styles the active review filter as the soft sleeve", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
			},
		});
		const select = screen.getByRole("combobox", {
			name: "Review filter selection",
		});
		const threadsButton = screen.getByRole("button", {
			name: "Hide review threads",
		});
		const control = threadsButton.parentElement as HTMLElement;

		expect(getComputedStyle(control).flexDirection).toBe("row");

		const sleeve = injectedStyleRule(
			[".review-filter-control-active"],
			[".review-filter-select", ".toolbar-btn"],
		).cssText;
		expect(sleeve).toContain("background: var(--color-accent-bg)");
		expect(sleeve).toContain(
			"box-shadow: inset 0 0 0 1px var(--color-accent-border)",
		);

		const selectSegment = injectedStyleRule([
			".review-filter-control-active",
			".review-filter-select",
			"select",
		]).cssText;
		expect(selectSegment).toContain(
			"border-radius: var(--radius) 0 0 var(--radius)",
		);
		expect(selectSegment).toContain("background: transparent");

		const toggleSegment = injectedStyleRule(
			[".review-filter-control-active", ".toolbar-btn"],
			[":hover"],
		).cssText;
		expect(toggleSegment).toContain(
			"border-radius: 0 var(--radius) var(--radius) 0",
		);
		expect(toggleSegment).toContain("background: var(--accent)");
		expect(control).toContainElement(select);
	});

	it("hides the filter selector when review threads are hidden", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewFilter: "none",
			},
		});
		expect(
			screen.queryByRole("combobox", { name: "Review filter selection" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Show review threads" }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it("slides the filter horizontally and removes motion when requested", () => {
		const node = document.createElement("label");
		node.style.cssText =
			"display: flex; width: 92px; height: 28px; padding: 0; margin: 0; border-width: 0";
		document.body.append(node);

		try {
			vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
			const horizontal = reviewFilterSlide(node);
			const collapsedDeclarations = (horizontal.css?.(0, 1) ?? "").split(";");
			expect(collapsedDeclarations).toContain("width: 0px");
			expect(collapsedDeclarations).not.toContain("height: 0px");
			expect(horizontal.duration).toBe(160);

			vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
			expect(reviewFilterSlide(node).duration).toBe(0);
		} finally {
			node.remove();
			vi.unstubAllGlobals();
		}
	});

	it.each(["all", "open", "addressed", "done", "dismissed", "stale"] as const)(
		"hides review threads from the %s filter",
		async (reviewFilter) => {
			const onreviewfilterchange = vi.fn();
			render(Toolbar, {
				props: {
					repoPath: "/test/repo",
					remoteState: makeRemoteState(),
					undoRedo: makeUndoRedo(),
					reviewActive: false,
					reviewFilter,
					onreviewfilterchange,
				},
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Hide review threads" }),
			);

			expect(onreviewfilterchange).toHaveBeenLastCalledWith("none");
		},
	);

	it("restores the selected filter when review threads are shown", async () => {
		const onreviewfilterchange = vi.fn();
		const view = render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewFilter: "addressed",
				onreviewfilterchange,
			},
		});

		await view.rerender({
			repoPath: "/test/repo",
			remoteState: makeRemoteState(),
			undoRedo: makeUndoRedo(),
			reviewActive: false,
			reviewFilter: "none",
			onreviewfilterchange,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Show review threads" }),
		);

		expect(onreviewfilterchange).toHaveBeenLastCalledWith("addressed");
	});

	it("offers every visible thread filter and no hidden state", () => {
		render(Toolbar, {
			props: {
				repoPath: "/test/repo",
				remoteState: makeRemoteState(),
				undoRedo: makeUndoRedo(),
				reviewActive: false,
				reviewFilter: "all",
			},
		});

		expect(
			screen.getAllByRole("option").map((option) => ({
				label: option.textContent,
				value: (option as HTMLOptionElement).value,
			})),
		).toEqual([
			{ label: "All threads", value: "all" },
			{ label: "Open", value: "open" },
			{ label: "Addressed", value: "addressed" },
			{ label: "Done", value: "done" },
			{ label: "Dismissed", value: "dismissed" },
			{ label: "Stale", value: "stale" },
		]);
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
