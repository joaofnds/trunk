import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../../tests/app/fakes/scheduler.js";
import { safeInvoke } from "../../lib/invoke.js";
import { createReviewComposerSession } from "../../lib/review-editors.svelte.js";
import { SCHEDULER } from "../../lib/scheduler.js";
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

	function renderComposer(
		opts: {
			scheduler?: FakeScheduler;
			activeReview?: {
				id: string;
				title: string;
				pending_count: number;
			} | null;
			activeReviewId?: string | null;
		} = {},
	) {
		return render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1, 2]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
				activeReview: opts.activeReview ?? null,
				activeReviewId: opts.activeReviewId ?? opts.activeReview?.id ?? null,
				originatingReviewId:
					opts.activeReviewId ?? opts.activeReview?.id ?? null,
			},
			...(opts.scheduler
				? { context: new Map([[SCHEDULER, opts.scheduler]]) }
				: {}),
		});
	}

	// The draft row has no review foreign key, so it survives a quit without
	// stranding a review — but only if the composer reads it back on mount.
	describe("draft restore", () => {
		const draftAnchor: Anchor = {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "Diff",
			side: "New",
			start_line: 11,
			end_line: 12,
		};

		function draftOnDisk(
			text: string,
			anchor: Anchor | null = draftAnchor,
			wholeFile = false,
		) {
			mockedInvoke.mockImplementation((cmd: string) =>
				cmd === "get_draft"
					? Promise.resolve({ text, anchor, whole_file: wholeFile })
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

		it("does not restore a whole-file draft into a selection of the same lines", async () => {
			draftOnDisk("about the whole file", draftAnchor, true);
			renderComposer();

			await flush();

			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
				"",
			);
		});

		it("restores a whole-file draft into a whole-file composer", async () => {
			draftOnDisk("about the whole file", draftAnchor, true);
			render(CommentComposer, {
				props: {
					captured: { anchor: draftAnchor, cachedExcerpt: "", wholeFile: true },
					commitOid: "abc123",
					repoPath: "/repo",
					onclose: () => {},
				},
			});

			await flush();

			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
				"about the whole file",
			);
		});

		it("does not restore a saved draft for another captured target", async () => {
			draftOnDisk("saved for another file", {
				...draftAnchor,
				file_path: "src/other.ts",
			});
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

	it("names a single line in the singular", () => {
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

		expect(screen.getByText("Comment on line 11")).toBeTruthy();
	});

	it("invites Markdown in the empty text", () => {
		renderComposer();

		expect(screen.getByRole("textbox")).toHaveAttribute(
			"placeholder",
			"Leave a comment… Markdown supported",
		);
	});

	it("says a shift-click extends the range where the host lets it", () => {
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
				extendable: true,
			},
		});

		expect(screen.getByText(/click a line number to extend/)).toHaveTextContent(
			"⇧ click a line number to extend · ⌘↵ to add comment",
		);
	});

	it("promises no extension where the host offers none", () => {
		renderComposer();

		expect(screen.queryByText(/to extend/)).toBeNull();
	});

	it("names the review the comment lands in", () => {
		renderComposer({
			activeReview: {
				id: "r3m9",
				title: "Graph lane colors",
				pending_count: 0,
			},
		});

		expect(screen.getByText(/Lands in/)).toHaveTextContent(
			"Lands in r3m9 Graph lane colors",
		);
	});

	// The review list and the active pointer are two reads, so the list can
	// fail or lag while the pointer stands, and the comment still lands there.
	it("names the active review by its id when the review list lacks it", () => {
		renderComposer({ activeReview: null, activeReviewId: "r3m9" });

		expect(screen.getByText(/Lands in/)).toHaveTextContent("Lands in r3m9");
	});

	it("says a comment with no active review starts a new one", () => {
		renderComposer({ activeReview: null });

		expect(screen.getByText(/Lands in/)).toHaveTextContent(
			"Lands in a new review",
		);
	});

	it.each([
		["Cmd+Enter", { metaKey: true }],
		["Ctrl+Enter", { ctrlKey: true }],
	])("submits on %s", async (_name, modifier) => {
		renderComposer();
		const textarea = screen.getByRole("textbox");
		await fireEvent.input(textarea, { target: { value: "ship it" } });

		await fireEvent.keyDown(textarea, { key: "Enter", ...modifier });
		await flush();

		expect(mockedInvoke.mock.calls.map((c) => c[0])).toContain("add_thread");
	});

	it("keeps a plain Enter for a new line in the comment", async () => {
		renderComposer();
		const textarea = screen.getByRole("textbox");
		await fireEvent.input(textarea, { target: { value: "first line" } });

		await fireEvent.keyDown(textarea, { key: "Enter" });
		await flush();

		expect(mockedInvoke.mock.calls.map((c) => c[0])).not.toContain(
			"add_thread",
		);
	});

	it.each([
		["an untouched draft", null, true],
		["a whitespace-only draft", "   ", true],
		["a non-empty draft", "looks good", false],
	])("Add comment is disabled for %s: %s", async (_name, value, disabled) => {
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
			name: "Add comment",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(disabled);
	});

	it("cannot submit while the review filter hides all threads", async () => {
		const onclose = vi.fn();
		render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose,
				canSubmit: false,
			},
		});

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "hidden comment" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

		expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
		expect(mockedInvoke.mock.calls.map((call) => call[0])).not.toContain(
			"add_thread",
		);
		expect(onclose).not.toHaveBeenCalled();
	});

	it("cannot submit after the active review changes", async () => {
		const onclose = vi.fn();
		const view = render(CommentComposer, {
			props: {
				file: modifiedFile,
				hunkIdx: 0,
				selectedLineIndices: new Set([1]),
				commitOid: "abc123",
				repoPath: "/repo",
				onclose,
				activeReviewId: "review-a",
				originatingReviewId: "review-a",
			},
		});

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "comment from review A" },
		});
		await view.rerender({
			file: modifiedFile,
			hunkIdx: 0,
			selectedLineIndices: new Set([1]),
			commitOid: "abc123",
			repoPath: "/repo",
			onclose,
			activeReviewId: "review-b",
			originatingReviewId: "review-a",
		});

		const submit = screen.getByRole("button", { name: "Add comment" });
		expect(submit).toBeDisabled();
		await fireEvent.click(submit);

		expect(mockedInvoke.mock.calls.map((call) => call[0])).not.toContain(
			"add_thread",
		);
		expect(onclose).not.toHaveBeenCalled();
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

	describe("delivery", () => {
		function deliveryOf(): unknown {
			const call = mockedInvoke.mock.calls.find((c) => c[0] === "add_thread");
			return (call?.[1] as { delivery?: unknown } | undefined)?.delivery;
		}

		async function type(text: string) {
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: text },
			});
		}

		it("sends the comment from Add comment", async () => {
			renderComposer({
				activeReview: { id: "r3m9", title: "t", pending_count: 0 },
			});
			await type("ship it");

			await fireEvent.click(
				screen.getByRole("button", { name: "Add comment" }),
			);
			await flush();

			expect(deliveryOf()).toBe("send");
		});

		it("holds the comment in a new batch from Start a batch", async () => {
			renderComposer({
				activeReview: { id: "r3m9", title: "t", pending_count: 0 },
			});
			await type("ship it");

			await fireEvent.click(
				screen.getByRole("button", { name: "Start a batch" }),
			);
			await flush();

			expect(deliveryOf()).toBe("hold");
		});

		describe("when the review holds a batch", () => {
			const batching = { id: "r3m9", title: "t", pending_count: 2 };

			it("adds the comment to the batch", async () => {
				renderComposer({ activeReview: batching });
				await type("ship it");

				await fireEvent.click(
					screen.getByRole("button", { name: "Add to batch" }),
				);
				await flush();

				expect(deliveryOf()).toBe("hold");
			});

			it("offers no way to send the comment alone", async () => {
				renderComposer({ activeReview: batching });

				await type("ship it");

				expect(
					screen.queryByRole("button", { name: "Add comment" }),
				).toBeNull();
				expect(
					screen.queryByRole("button", { name: "Start a batch" }),
				).toBeNull();
			});
		});
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

		const submit = screen.getByRole("button", { name: "Add comment" });
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

	it("keeps a pending submit disabled when the composer remounts", async () => {
		let releaseSubmit!: () => void;
		mockedInvoke.mockImplementation((command: string) =>
			command === "add_thread"
				? new Promise<void>((resolve) => {
						releaseSubmit = resolve;
					})
				: Promise.resolve(undefined),
		);
		const session = createReviewComposerSession();
		const props = {
			file: modifiedFile,
			hunkIdx: 0,
			selectedLineIndices: new Set([1, 2]),
			commitOid: "abc123",
			repoPath: "/repo",
			onclose: () => {},
			composerSession: session,
		};
		let view = render(CommentComposer, { props });

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "one pending comment" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await tick();

		expect(session.submitting).toBe(true);
		view.unmount();
		view = render(CommentComposer, { props });
		expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();

		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		expect(
			mockedInvoke.mock.calls.filter((call) => call[0] === "add_thread"),
		).toHaveLength(1);

		releaseSubmit();
		await flush();
		expect(session.submitting).toBe(false);
		view.unmount();
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

		it("deletes the draft row when the operator accepts the discard", async () => {
			const ask = await getAskMock();
			ask.mockResolvedValue(true);
			const { component } = renderComposer();
			await dirtyTheDraft();

			await component.confirmDiscardIfDirty();

			expect(mockedInvoke.mock.calls.map((c) => c[0])).toContain(
				"delete_draft",
			);
		});
	});

	// The autosave is an IPC call with no cancel. A discard or submit issued while
	// one is in flight races it on the backend, and a save that lands last brings
	// back the draft the user just gave up, so both wait for it to settle.
	describe("with an autosave in flight", () => {
		function holdSaveDraft() {
			let release = () => {};
			mockedInvoke.mockImplementation((cmd: string) =>
				cmd === "save_draft"
					? new Promise<undefined>((resolve) => {
							release = () => resolve(undefined);
						})
					: Promise.resolve(undefined),
			);
			return () => release();
		}

		function commands() {
			return mockedInvoke.mock.calls.map((c) => c[0]);
		}

		async function typeAndFireTheAutosave(scheduler: FakeScheduler) {
			await flush();
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "half a thought" },
			});
			scheduler.flush();
			await tick();
			expect(commands()).toContain("save_draft");
		}

		it("cancel deletes the draft only once the save has settled", async () => {
			const scheduler = new FakeScheduler();
			const releaseSave = holdSaveDraft();
			renderComposer({ scheduler });
			await typeAndFireTheAutosave(scheduler);

			await fireEvent.click(screen.getByText("Cancel"));
			await tick();
			expect(commands()).not.toContain("delete_draft");

			releaseSave();
			await flush();

			expect(commands()).toContain("delete_draft");
		});

		it("submit adds the thread only once the save has settled", async () => {
			const scheduler = new FakeScheduler();
			const releaseSave = holdSaveDraft();
			renderComposer({ scheduler });
			await typeAndFireTheAutosave(scheduler);

			await fireEvent.click(
				screen.getByRole("button", { name: "Add comment" }),
			);
			await tick();
			expect(commands()).not.toContain("add_thread");

			releaseSave();
			await flush();

			expect(commands()).toContain("add_thread");
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
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
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

		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
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

	describe("whole-file scope", () => {
		const fileAnchor: Anchor = {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "FullFile",
			side: "New",
			start_line: 1,
			end_line: 3,
		};

		async function submitComment(props: Record<string, unknown>) {
			render(CommentComposer, {
				props: {
					commitOid: "abc123",
					repoPath: "/repo",
					onclose: () => {},
					...props,
				},
			});
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "split this file" },
			});
			await tick();
			await fireEvent.click(
				screen.getByRole("button", { name: "Add comment" }),
			);
			await tick();
		}

		function argsOf(command: string) {
			return mockedInvoke.mock.calls.find((c) => c[0] === command)?.[1];
		}

		it("sends a comment on the whole file as about the whole file", async () => {
			await submitComment({
				captured: { anchor: fileAnchor, cachedExcerpt: "", wholeFile: true },
			});

			expect(argsOf("add_thread")).toMatchObject({ wholeFile: true });
		});

		it("sends a comment on lines as about those lines", async () => {
			await submitComment({
				captured: { anchor: fileAnchor, cachedExcerpt: "a\nb\nc" },
			});

			expect(argsOf("add_thread")).toMatchObject({ wholeFile: false });
		});

		it("sends a comment on the whole current file as about the whole file", async () => {
			await submitComment({
				captured: { anchor: fileAnchor, cachedExcerpt: "", wholeFile: true },
				currentFile: { filePath: "src/main.ts", startLine: 1, endLine: 3 },
			});

			expect(argsOf("add_current_file_thread")).toMatchObject({
				wholeFile: true,
			});
		});
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

	it("saves a whole-file comment's draft as about the whole file", async () => {
		vi.useFakeTimers();
		render(CommentComposer, {
			props: {
				captured: {
					anchor: {
						commit_oid: "abc123",
						file_path: "src/main.ts",
						source: "FullFile",
						side: "New",
						start_line: 1,
						end_line: 3,
					},
					cachedExcerpt: "",
					wholeFile: true,
				},
				commitOid: "abc123",
				repoPath: "/repo",
				onclose: () => {},
			},
		});

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "split this file" },
		});
		await vi.advanceTimersByTimeAsync(300);
		await tick();

		const saved = mockedInvoke.mock.calls.find((c) => c[0] === "save_draft");
		expect(saved?.[1]).toMatchObject({ wholeFile: true });
	});

	it("never saves the draft once the composer is gone", async () => {
		const scheduler = new FakeScheduler();
		const { unmount } = renderComposer({ scheduler });
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "typed, then closed" },
		});
		expect(scheduler.pending).toBe(1);

		unmount();
		scheduler.flush();
		await tick();

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
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await tick();

		const addCalls = mockedInvoke.mock.calls.filter(
			(c) => c[0] === "add_thread",
		);
		expect(addCalls).toHaveLength(1);
		const args = addCalls[0][1] as { anchor: { side: string } };
		expect(args.anchor.side).toBe("New");
	});
});
