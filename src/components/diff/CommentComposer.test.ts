import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "../../lib/invoke.js";
import { _resetToasts, toasts } from "../../lib/toast.svelte.js";
import type { Anchor, FileDiff } from "../../lib/types.js";
import CommentComposer from "./CommentComposer.svelte";

// Shared Tauri mock (provides plugin-dialog `ask`, etc.)
import "../../__tests__/helpers/tauri-mock";

vi.mock("../../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/invoke.js")>()),
	safeInvoke: vi.fn().mockResolvedValue(undefined),
}));

const mockedInvoke = vi.mocked(safeInvoke);

// A Modified file whose hunk holds context + add + delete lines. The selection
// fixtures below pick line indices into this hunk.
const modifiedFile: FileDiff = {
	path: "src/main.ts",
	old_path: null,
	status: "Modified",
	is_binary: false,
	hunks: [
		{
			header: "@@ -10,3 +10,4 @@",
			old_start: 10,
			old_lines: 3,
			new_start: 10,
			new_lines: 4,
			lines: [
				{
					origin: "Context",
					content: "context before",
					old_lineno: 10,
					new_lineno: 10,
					spans: [],
				},
				{
					origin: "Add",
					content: "added one",
					old_lineno: null,
					new_lineno: 11,
					spans: [],
				},
				{
					origin: "Add",
					content: "added two",
					old_lineno: null,
					new_lineno: 12,
					spans: [],
				},
				{
					origin: "Delete",
					content: "removed one",
					old_lineno: 11,
					new_lineno: null,
					spans: [],
				},
			],
		},
	],
};

async function flush() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

async function getAskMock() {
	const dialog = await import("@tauri-apps/plugin-dialog");
	return vi.mocked(dialog.ask);
}

describe("CommentComposer", () => {
	beforeEach(() => {
		mockedInvoke.mockReset();
		mockedInvoke.mockResolvedValue(undefined);
		_resetToasts();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function renderComposer() {
		return render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1, 2]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});
	}

	// The draft row has no review foreign key, so it survives a quit without
	// stranding a review — but only if the composer reads it back on mount.
	describe("draft restore", () => {
		function draftOnDisk(text: string) {
			mockedInvoke.mockImplementation((cmd: string) =>
				cmd === "get_draft"
					? Promise.resolve({ text, anchor: null })
					: Promise.resolve(undefined),
			);
		}

		it("restores the autosaved draft into the textarea", async () => {
			draftOnDisk("half typed, then quit");
			renderComposer();

			await flush();

			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
				"half typed, then quit",
			);
		});

		it("discards the draft row when the composer is cancelled", async () => {
			draftOnDisk("abandoned");
			renderComposer();
			await flush();

			await fireEvent.click(screen.getByText("Cancel"));
			await flush();

			expect(mockedInvoke.mock.calls.map((c) => c[0] as string)).toContain(
				"delete_draft",
			);
		});

		it("leaves the textarea empty when the repo has no draft", async () => {
			mockedInvoke.mockResolvedValue(null);
			renderComposer();

			await flush();

			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
				"",
			);
		});
	});

	it("renders a 'Comments on lines N-M' preview matching the collapsed range", () => {
		// Selecting the two Add lines (indices 1,2) -> New side, new_lineno 11..12.
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1, 2]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		expect(screen.getByText("Comments on lines 11-12")).toBeTruthy();
	});

	it.each([
		["an untouched draft", null, true],
		["a whitespace-only draft", "   ", true],
		["a non-empty draft", "looks good", false],
	])("Submit is disabled for %s: %s", async (_name, value, disabled) => {
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		if (value !== null) {
			await fireEvent.input(screen.getByRole("textbox"), { target: { value } });
			await tick();
		}

		const submit = screen.getByRole("button", {
			name: /submit/i,
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(disabled);
	});

	it("persists a draft via save_draft after the debounce idle window", async () => {
		vi.useFakeTimers();
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "draft text" } });

		// Before the debounce fires, no draft invoke.
		expect(
			mockedInvoke.mock.calls.filter((c) => c[0] === "save_draft"),
		).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(300);
		await tick();

		const draftCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "save_draft",
		);
		expect(draftCalls).toHaveLength(1);
		const args = draftCalls[0][1] as {
			path: string;
			text: string;
			anchor: { side: string; start_line: number; end_line: number };
		};
		expect(args.path).toBe("/repo");
		expect(args.text).toBe("draft text");
		expect(args.anchor.side).toBe("New");
		expect(args.anchor.start_line).toBe(11);
	});

	it("submits via add_thread with the buildDiffAnchor anchor + cachedExcerpt and clears on success", async () => {
		const onclose = vi.fn();
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1, 2]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose,
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "ship it" } });
		await tick();

		const submit = screen.getByRole("button", { name: /submit/i });
		await fireEvent.click(submit);
		await tick();

		const addCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "add_thread",
		);
		expect(addCalls).toHaveLength(1);
		const args = addCalls[0][1] as {
			path: string;
			text: string;
			anchor: { commit_oid: string; side: string; start_line: number };
			cachedExcerpt: string;
		};
		expect(args.path).toBe("/repo");
		expect(args.text).toBe("ship it");
		expect(args.anchor.commit_oid).toBe("abc123");
		expect(args.anchor.side).toBe("New");
		expect(args.anchor.start_line).toBe(11);
		expect(typeof args.cachedExcerpt).toBe("string");
		expect(args.cachedExcerpt.length).toBeGreaterThan(0);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	describe("confirmDiscardIfDirty", () => {
		function renderComposer() {
			return render(CommentComposer, {
				props: {
					file: modifiedFile,
					hunkIdx: 0,
					selectedLineIndices: new Set([1]),
					commitOid: "abc123",
					repoPath: "/repo",
					onclose: () => {},
				},
			});
		}

		async function dirtyTheDraft() {
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "unsaved" },
			});
			await tick();
		}

		it("allows the switch without asking when the draft is untouched", async () => {
			const ask = await getAskMock();
			const { component } = renderComposer();

			const allowed = await component.confirmDiscardIfDirty();

			expect(ask).not.toHaveBeenCalled();
			expect(allowed).toBe(true);
		});

		it("blocks the switch when the operator declines the discard", async () => {
			const ask = await getAskMock();
			ask.mockResolvedValue(false);
			const { component } = renderComposer();
			await dirtyTheDraft();

			const allowed = await component.confirmDiscardIfDirty();

			expect(allowed).toBe(false);
		});

		it("allows the switch when the operator accepts the discard", async () => {
			const ask = await getAskMock();
			ask.mockResolvedValue(true);
			const { component } = renderComposer();
			await dirtyTheDraft();

			const allowed = await component.confirmDiscardIfDirty();

			expect(allowed).toBe(true);
		});
	});

	it("keeps the draft and reports the failure when add_thread rejects", async () => {
		mockedInvoke.mockImplementation((cmd: string) =>
			cmd === "add_thread"
				? Promise.reject({ code: "git_error", message: "backend refused" })
				: Promise.resolve(undefined),
		);
		const onclose = vi.fn();
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose,
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "worth keeping" } });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /submit/i }));
		await tick();

		expect(toasts.items.map((t) => [t.message, t.kind])).toEqual([
			["backend refused", "error"],
		]);
		expect(textarea.value).toBe("worth keeping");
		expect(onclose).not.toHaveBeenCalled();
	});

	it("uses the injected captured FullFile result for the preview without calling buildDiffAnchor", () => {
		const capturedAnchor: Anchor = {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "FullFile",
			side: "New",
			start_line: 40,
			end_line: 42,
		};
		// No file/hunkIdx/selectedLineIndices — the full-file host passes only the
		// captured result + commitOid + repoPath.
		render(CommentComposer, {
			props: {
				captured: {
					anchor: capturedAnchor,
					cachedExcerpt: "line forty\nline forty-one\nline forty-two",
				},
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		expect(screen.getByText("Comments on lines 40-42")).toBeTruthy();
	});

	it("submits via add_thread with the injected FullFile anchor + cachedExcerpt (V7)", async () => {
		const capturedAnchor: Anchor = {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "FullFile",
			side: "New",
			start_line: 40,
			end_line: 42,
		};
		const onclose = vi.fn();
		render(CommentComposer, {
			props: {
				captured: {
					anchor: capturedAnchor,
					cachedExcerpt: "line forty\nline forty-one\nline forty-two",
				},
				commitOid: "abc123",
				repoPath: "/repo",
				onclose,
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "full file note" } });
		await tick();

		await fireEvent.click(screen.getByRole("button", { name: /submit/i }));
		await tick();

		const addCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "add_thread",
		);
		expect(addCalls).toHaveLength(1);
		const args = addCalls[0][1] as {
			path: string;
			text: string;
			anchor: { source: string; side: string; start_line: number };
			cachedExcerpt: string;
		};
		expect(args.path).toBe("/repo");
		expect(args.text).toBe("full file note");
		expect(args.anchor.source).toBe("FullFile");
		expect(args.anchor.side).toBe("New");
		expect(args.anchor.start_line).toBe(40);
		expect(args.cachedExcerpt).toBe(
			"line forty\nline forty-one\nline forty-two",
		);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("persists a draft via save_draft with the injected anchor on the debounce (V8)", async () => {
		vi.useFakeTimers();
		const capturedAnchor: Anchor = {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "FullFile",
			side: "New",
			start_line: 40,
			end_line: 42,
		};
		render(CommentComposer, {
			props: {
				captured: {
					anchor: capturedAnchor,
					cachedExcerpt: "line forty",
				},
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "draft full file" } });

		expect(
			mockedInvoke.mock.calls.filter((c) => c[0] === "save_draft"),
		).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(300);
		await tick();

		const draftCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "save_draft",
		);
		expect(draftCalls).toHaveLength(1);
		const args = draftCalls[0][1] as {
			path: string;
			text: string;
			anchor: { source: string; start_line: number };
		};
		expect(args.path).toBe("/repo");
		expect(args.text).toBe("draft full file");
		expect(args.anchor.source).toBe("FullFile");
		expect(args.anchor.start_line).toBe(40);
	});

	it("never saves the draft once the composer is gone", async () => {
		vi.useFakeTimers();
		const { unmount } = renderComposer();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "typed, then closed" },
		});

		unmount();
		await vi.advanceTimersByTimeAsync(300);

		expect(
			mockedInvoke.mock.calls.filter((c) => c[0] === "save_draft"),
		).toHaveLength(0);
	});

	it("produces a New-side anchor for a split/new-side (Add-only) selection", async () => {
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				// Split view only ever passes Add-origin indices (right column).
				selectedLineIndices: new Set([1, 2]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "new side only" } });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /submit/i }));
		await tick();

		const addCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "add_thread",
		);
		expect(addCalls).toHaveLength(1);
		const args = addCalls[0][1] as { anchor: { side: string } };
		expect(args.anchor.side).toBe("New");
	});
});
