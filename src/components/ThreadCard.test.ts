import { fireEvent, render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aReply, aThread } from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import type { Thread } from "../lib/types.js";
import ThreadCard from "./ThreadCard.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask`, defaulting to false).
import "../__tests__/helpers/tauri-mock";

// review-comment-actions.ts is owned code (a thin wrapper over safeInvoke), so
// this asserts on safeInvoke, the real IPC boundary, matching the pattern used
// for the same wiring in ReviewPanel.test.ts, CommitDetail.test.ts, and the
// three diff-host test files.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(),
	};
});

function calledCommands(): string[] {
	return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
}

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

// The delete-confirmation flow awaits a dynamic `import()` before calling `ask`;
// a plain `fireEvent.click` doesn't wait for that microtask to settle.
async function flush() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

describe("ThreadCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(safeInvoke).mockResolvedValue(undefined);
	});

	const comment: Thread = aThread({
		id: "c1",
		text: "needs a null check here",
		anchor: {
			commit_oid: "abc123",
			file_path: "src/foo.ts",
			source: "Diff",
			side: "New",
			start_line: 10,
			end_line: 11,
		},
		cached_excerpt: "+const x = 2;\n const y = 3;",
		commit_oid: "abc123",
	});

	function renderCard(
		overrides: Partial<ComponentProps<typeof ThreadCard>> = {},
	) {
		return render(ThreadCard, {
			props: {
				thread: comment,
				repoPath: "/repo",
				onedit: () => {},
				ondelete: () => {},
				...overrides,
			},
		});
	}

	const currentFileComment: Thread = aThread({
		id: "c2",
		text: "this constant needs a name",
		anchor: null,
		cached_excerpt: "const answer = 42;",
		content_pin: {
			file_path: "src/untouched.ts",
			block: "const answer = 42;",
			ordinal: 0,
			start_line: 1,
			end_line: 1,
		},
	});

	it("locates a current-file comment by its pin, which carries no anchor", () => {
		renderCard({ thread: currentFileComment });

		expect(screen.getByText("src/untouched.ts:L1-L1")).toBeTruthy();
	});

	it("locates it at the line the backend last resolved the block to", () => {
		renderCard({
			thread: { ...currentFileComment, resolved_start_line: 7 },
		});

		expect(screen.getByText("src/untouched.ts:L7-L7")).toBeTruthy();
	});

	/// A stale current-file thread points at code that is gone, so the excerpt is
	/// the only place its subject survives.
	it("still shows the excerpt of a stale current-file comment", () => {
		renderCard({
			thread: { ...currentFileComment, stale: true },
			orphaned: true,
			orphanLabel: "code gone",
		});

		expect(screen.getByText("const answer = 42;")).toBeTruthy();
		expect(screen.getByText("code gone")).toBeTruthy();
	});

	it("keeps the comment body and excerpt code selectable while the gutter stays unselectable", () => {
		const { container } = renderCard();

		expect(screen.getByText(comment.text)).toHaveClass("select-text");
		expect(screen.getByText("const x = 2;")).toHaveClass("select-text");

		const gutter = container.querySelector(".diff-gutter") as HTMLElement;
		expect(gutter).toHaveClass("select-none");
		expect(gutter).not.toHaveClass("select-text");
	});

	it("renders the backend-provided markdown HTML and keeps select-text inline", () => {
		const md: Thread = {
			...comment,
			text: "**bold** body",
			text_html: "<p><strong>bold</strong> body</p>",
		};
		const { container } = renderCard({ thread: md });

		const body = container.querySelector(".comment-card-text") as HTMLElement;
		expect(body.querySelector("strong")?.textContent).toBe("bold");
		// select-text must stay INLINE on the wrapper (jsdom only reads inline
		// styles; a scoped class wouldn't unit-assert).
		expect(body).toHaveClass("select-text");
	});

	it("falls back to raw text when no rendered HTML is present", () => {
		const { container } = renderCard();
		const body = container.querySelector(".comment-card-text") as HTMLElement;
		expect(body.tagName).toBe("SPAN");
		expect(body.textContent).toBe(comment.text);
	});

	it("renders a reply with its attribution", () => {
		const withReply: Thread = {
			...comment,
			replies: [
				aReply({
					id: "r1",
					text: "fixed",
					text_html: "<p>fixed</p>",
					channel: "agent",
				}),
			],
		};

		renderCard({ thread: withReply });

		expect(screen.getByText("fixed")).toBeInTheDocument();
		expect(screen.getByText("agent")).toBeInTheDocument();
	});

	it("renders the root's own channel attribution in the card header", () => {
		// A reply's channel chip has always rendered; the root's never did.
		// Agent-originated roots are spec-deferred (every root is `human` in
		// practice today), so this overrides the fixture to cover
		// the gap while it's cheap, ahead of that channel shipping.
		const agentRoot: Thread = { ...comment, channel: "agent" };

		const { container } = renderCard({ thread: agentRoot });

		const chip = container.querySelector(".comment-card-channel");
		expect(chip).toBeInTheDocument();
		expect(chip).toHaveTextContent("agent");
	});

	it("collapses to the last three replies", () => {
		const fiveReplies: Thread = {
			...comment,
			replies: [1, 2, 3, 4, 5].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: fiveReplies });

		expect(screen.queryByText("reply 1")).not.toBeInTheDocument();
		expect(screen.queryByText("reply 2")).not.toBeInTheDocument();
		expect(screen.getByText("reply 3")).toBeInTheDocument();
		expect(screen.getByText("reply 4")).toBeInTheDocument();
		expect(screen.getByText("reply 5")).toBeInTheDocument();
	});

	it("reveals the hidden replies on click", async () => {
		const fiveReplies: Thread = {
			...comment,
			replies: [1, 2, 3, 4, 5].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: fiveReplies });

		await fireEvent.click(screen.getByText("Show 2 more replies"));

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(screen.getByText("reply 2")).toBeInTheDocument();
	});

	it("shows every reply with no expand control when there are three or fewer", () => {
		const threeReplies: Thread = {
			...comment,
			replies: [1, 2, 3].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: threeReplies });

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
	});

	it("shows the thread's current state in a chip", () => {
		const dismissed: Thread = { ...comment, state: "dismissed" };

		renderCard({ thread: dismissed });

		expect(screen.getByText("dismissed")).toBeInTheDocument();
	});

	// Edit/Delete render as .card-action too but never vary by state; excluding
	// them by name (rather than keeping only the labels each row expects)
	// means a label neither list names still shows up here and fails the
	// comparison, instead of being silently filtered away.
	const STATIC_ACTION_LABELS = ["Edit", "Delete"];

	function stateActionLabels(container: HTMLElement) {
		return Array.from(container.querySelectorAll(".card-action"))
			.map((b) => b.textContent)
			.filter((label) => !STATIC_ACTION_LABELS.includes(label ?? ""));
	}

	// Each row mirrors what the wire sends for that state (the backend's
	// human-channel allowed_transitions, in wire order) and pins the label per
	// target. The set itself is the backend's; only the wording is the card's.
	it.each([
		{
			state: "open" as const,
			allowed: ["done", "dismissed"] as const,
			labels: ["Mark done", "Dismiss"],
		},
		{
			state: "addressed" as const,
			allowed: ["done", "dismissed", "open"] as const,
			labels: ["Mark done", "Dismiss", "Reopen"],
		},
		{ state: "done" as const, allowed: ["open"] as const, labels: ["Reopen"] },
		{
			state: "dismissed" as const,
			allowed: ["open"] as const,
			labels: ["Reopen"],
		},
	])("offers $labels for a $state thread", ({ state, allowed, labels }) => {
		const { container } = renderCard({
			thread: { ...comment, state, allowed_transitions: [...allowed] },
		});

		expect(stateActionLabels(container)).toEqual(labels);
	});

	it("renders its state actions from allowed_transitions, not from the state", () => {
		// A list the matrix would never pair with "open": a local switch on the
		// state would offer Mark done / Dismiss and this expectation would fail.
		const mismatched: Thread = {
			...comment,
			state: "open",
			allowed_transitions: ["open"],
		};

		const { container } = renderCard({ thread: mismatched });

		expect(stateActionLabels(container)).toEqual(["Reopen"]);
	});

	it("calls setThreadState with the repo path and target state when Mark done is clicked", async () => {
		renderCard();

		await fireEvent.click(screen.getByText("Mark done"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "done",
		});
	});

	it("calls setThreadState with the repo path and target state when Dismiss is clicked", async () => {
		renderCard();

		await fireEvent.click(screen.getByText("Dismiss"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "dismissed",
		});
	});

	it("calls setThreadState with the repo path and target state when Reopen is clicked", async () => {
		const done: Thread = {
			...comment,
			state: "done",
			allowed_transitions: ["open"],
		};
		renderCard({ thread: done });

		await fireEvent.click(screen.getByText("Reopen"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "open",
		});
	});

	it("seeds the reply editor with the reply's text", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		renderCard({ thread: humanReply });

		await fireEvent.click(screen.getByText("Edit reply"));

		const textarea = screen.getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		expect(textarea.value).toBe("original");
	});

	it("keeps root and reply drafts when the card remounts", async () => {
		const editorSession = createThreadEditorSession();
		const first = renderCard({ editorSession });

		await fireEvent.click(screen.getByText("Edit"));
		await fireEvent.input(screen.getAllByRole("textbox")[0], {
			target: { value: "unfinished root" },
		});
		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "unfinished reply" },
		});
		first.unmount();

		renderCard({ editorSession });

		expect(screen.getAllByRole("textbox")[0]).toHaveValue("unfinished root");
		expect(screen.getByLabelText("Reply")).toHaveValue("unfinished reply");
	});

	it("keeps an active reply edit when the card remounts", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		const editorSession = createThreadEditorSession();
		const first = renderCard({ thread: humanReply, editorSession });

		await fireEvent.click(screen.getByText("Edit reply"));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "unfinished reply edit" },
		});
		first.unmount();

		renderCard({ thread: humanReply, editorSession });

		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"unfinished reply edit",
		);
	});

	it("calls editReply with the repo path, reply id, and new text", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		renderCard({ thread: humanReply });

		await fireEvent.click(screen.getByText("Edit reply"));
		const textarea = screen.getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "corrected" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(calledCommands()).toContain("edit_reply");
		expect(callArgs("edit_reply")).toEqual({
			path: "/repo",
			id: "r1",
			text: "corrected",
		});
	});

	it("submits the typed reply via addReply with the repo path and clears the composer", async () => {
		renderCard();

		const textarea = screen.getByLabelText("Reply") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "sounds good" } });
		await fireEvent.click(screen.getByText("Reply"));

		expect(calledCommands()).toContain("add_reply");
		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "c1",
			text: "sounds good",
		});
		expect(textarea.value).toBe("");
	});

	it("does not offer Edit for an agent reply", () => {
		const agentReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		renderCard({ thread: agentReply });

		expect(screen.queryByText("Edit reply")).not.toBeInTheDocument();
	});

	it("offers Delete for every reply and calls deleteReply with the repo path and id once confirmed", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(true);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		renderCard({ thread: withReply });

		await fireEvent.click(screen.getByText("Delete reply"));
		await flush();

		expect(ask).toHaveBeenCalledTimes(1);
		expect(calledCommands()).toContain("delete_reply");
		expect(callArgs("delete_reply")).toEqual({ path: "/repo", id: "r1" });
	});

	it("does not call deleteReply when the reply-delete confirmation is cancelled", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(false);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		renderCard({ thread: withReply });

		await fireEvent.click(screen.getByText("Delete reply"));
		await flush();

		expect(ask).toHaveBeenCalledTimes(1);
		expect(calledCommands()).not.toContain("delete_reply");
	});

	// Once the owning review is published, the store refuses to delete a
	// thread or a reply (criterion 12) — offering the control anyway just
	// buys a round trip to the same refusal, so it's hidden instead.
	it("offers Delete for an unpublished thread and hides it once the review is published", async () => {
		const { rerender } = renderCard();

		expect(screen.getByText("Delete")).toBeInTheDocument();

		await rerender({
			thread: { ...comment, published: true },
			repoPath: "/repo",
			onedit: () => {},
			ondelete: () => {},
		});

		expect(screen.queryByText("Delete")).not.toBeInTheDocument();
	});

	it("hides Delete reply once the owning review is published", () => {
		const published: Thread = {
			...comment,
			published: true,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		renderCard({ thread: published });

		expect(screen.queryByText("Delete reply")).not.toBeInTheDocument();
	});
});
