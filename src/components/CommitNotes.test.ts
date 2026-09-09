import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
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

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

function renderNotes(notes = [] as ReturnType<typeof aThread>[]) {
	return render(CommitNotes, {
		props: { notes, repoPath: "/repo", commitOid },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
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
		vi.mocked(safeInvoke).mockResolvedValue(undefined);
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
});
