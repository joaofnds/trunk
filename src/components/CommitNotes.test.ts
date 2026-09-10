import { fireEvent, render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { createReviewEditorStore } from "../lib/review-editors.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import CommitNotes from "./CommitNotes.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

// Command-aware safeInvoke dispatcher, matching CommitDetail.test.ts: the save
// routes through safeInvoke, so asserting on it exercises the real
// review-comment-actions.ts wiring instead of mocking a module this project owns.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return { ...actual, safeInvoke: vi.fn() };
});

const commitOid = "abc123def456";

function callCount(cmd: string): number {
	return vi.mocked(safeInvoke).mock.calls.filter((c) => c[0] === cmd).length;
}

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

function renderNotes(
	notes = [] as ReturnType<typeof aThread>[],
	overrides: Partial<ComponentProps<typeof CommitNotes>> = {},
) {
	return render(CommitNotes, {
		props: { notes, repoPath: "/repo", commitOid, ...overrides },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("CommitNotes", () => {
	it("renders the notes heading with no count when the commit has no notes", () => {
		renderNotes();

		expect(screen.getByText("Notes")).toBeInTheDocument();
	});

	it("renders each note's text and counts them in the heading", () => {
		renderNotes([
			aThread({ id: "note-1", text: "first note", commit_oid: commitOid }),
			aThread({ id: "note-2", text: "second note", commit_oid: commitOid }),
		]);

		expect(screen.getByText("first note")).toBeInTheDocument();
		expect(screen.getByText("second note")).toBeInTheDocument();
		expect(screen.getByText("Notes(2)")).toBeInTheDocument();
	});

	it("saves a composed note via add_commit_thread with the repo path and commit oid", async () => {
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		const textarea = screen.getByPlaceholderText(
			"Leave a note on this commit…",
		);
		await fireEvent.input(textarea, { target: { value: "  a new note  " } });
		await fireEvent.click(screen.getByText("Save"));

		expect(callArgs("add_commit_thread")).toEqual({
			path: "/repo",
			commitOid,
			text: "a new note",
		});
	});

	it("closes the composer once the note is saved", async () => {
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		const textarea = screen.getByPlaceholderText(
			"Leave a note on this commit…",
		);
		await fireEvent.input(textarea, { target: { value: "a new note" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(
			screen.queryByPlaceholderText("Leave a note on this commit…"),
		).not.toBeInTheDocument();
	});

	it("keeps the composer open and saves nothing when the text is only whitespace", async () => {
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		const textarea = screen.getByPlaceholderText(
			"Leave a note on this commit…",
		);
		await fireEvent.input(textarea, { target: { value: "   " } });
		await fireEvent.click(screen.getByText("Save"));

		expect(callArgs("add_commit_thread")).toBeUndefined();
		expect(textarea).toBeInTheDocument();
	});

	it("saves once when Save is clicked again while the first save is in flight", async () => {
		let settleSave = () => {};
		vi.mocked(safeInvoke).mockReturnValue(
			new Promise<void>((resolve) => {
				settleSave = resolve;
			}),
		);
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		await fireEvent.input(
			screen.getByPlaceholderText("Leave a note on this commit…"),
			{ target: { value: "a new note" } },
		);
		await fireEvent.click(screen.getByText("Save"));
		await fireEvent.click(screen.getByText("Save"));
		settleSave();

		expect(callCount("add_commit_thread")).toBe(1);
	});

	it("does not clear a replacement commit draft when the first save resolves", async () => {
		let settleFirst!: () => void;
		vi.mocked(safeInvoke).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				settleFirst = resolve;
			}),
		);
		const editors = createReviewEditorStore();
		const editorDraftFor = (
			reviewId: string | null,
			surface: string,
			target: string,
		) => editors.draft(reviewId, surface, target);
		const view = renderNotes([], {
			activeReviewId: "review-a",
			editorDraftFor,
		});

		await fireEvent.click(screen.getByText("Add note"));
		await fireEvent.input(
			screen.getByPlaceholderText("Leave a note on this commit…"),
			{ target: { value: "note for first commit" } },
		);
		await fireEvent.click(screen.getByText("Save"));

		await view.rerender({
			notes: [],
			repoPath: "/repo",
			commitOid: "different-commit",
			activeReviewId: "review-a",
			editorDraftFor,
		});
		await fireEvent.click(screen.getByText("Add note"));
		await fireEvent.input(
			screen.getByPlaceholderText("Leave a note on this commit…"),
			{ target: { value: "note for replacement commit" } },
		);

		settleFirst();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
		expect(
			screen.getByPlaceholderText("Leave a note on this commit…"),
		).toHaveValue("note for replacement commit");
	});

	it("reports a refused save and leaves the composed text on screen", async () => {
		vi.mocked(safeInvoke).mockRejectedValue(new Error("review is published"));
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		await fireEvent.input(
			screen.getByPlaceholderText("Leave a note on this commit…"),
			{ target: { value: "a new note" } },
		);
		await fireEvent.click(screen.getByText("Save"));

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"review is published",
			"error",
		);
		expect(
			screen.getByPlaceholderText("Leave a note on this commit…"),
		).toHaveValue("a new note");
	});

	it("discards the composed text when the composer is cancelled", async () => {
		renderNotes();

		await fireEvent.click(screen.getByText("Add note"));
		await fireEvent.input(
			screen.getByPlaceholderText("Leave a note on this commit…"),
			{ target: { value: "abandoned" } },
		);
		await fireEvent.click(screen.getByText("Cancel"));
		await fireEvent.click(screen.getByText("Add note"));

		expect(
			screen.getByPlaceholderText("Leave a note on this commit…"),
		).toHaveValue("");
	});

	it("hides the notes chrome and active composer for Hide all", async () => {
		const { container, rerender } = renderNotes([], { reviewFilter: "none" });
		const root = container.querySelector(".commit-notes");

		expect(root).toHaveStyle({ display: "none" });
		expect(root).toHaveAttribute("aria-hidden", "true");
		expect(
			screen.queryByRole("button", { name: "Add note" }),
		).not.toBeInTheDocument();

		await rerender({
			notes: [],
			repoPath: "/repo",
			commitOid,
			reviewFilter: "all",
		});
		await fireEvent.click(screen.getByText("Add note"));
		await rerender({
			notes: [],
			repoPath: "/repo",
			commitOid,
			reviewFilter: "none",
		});

		expect(container.querySelector(".commit-notes")).toHaveStyle({
			display: "none",
		});
		expect(
			screen.queryByRole("textbox", {
				name: "Leave a note on this commit…",
			}),
		).not.toBeInTheDocument();
	});
});
