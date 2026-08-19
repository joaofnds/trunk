import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aReply, aThread } from "../__tests__/helpers/thread-fixture.js";
import type { Thread } from "../lib/types.js";
import ThreadCard from "./ThreadCard.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask`, defaulting to false).
import "../__tests__/helpers/tauri-mock";

// The delete-confirmation flow awaits a dynamic `import()` before calling `ask`;
// a plain `fireEvent.click` doesn't wait for that microtask to settle.
async function flush() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

describe("ThreadCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	it("keeps the comment body and excerpt code selectable while the gutter stays unselectable", () => {
		const { container } = render(ThreadCard, {
			props: {
				comment,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

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
		const { container } = render(ThreadCard, {
			props: {
				comment: md,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		const body = container.querySelector(".comment-card-text") as HTMLElement;
		expect(body.querySelector("strong")?.textContent).toBe("bold");
		// select-text must stay INLINE on the wrapper (jsdom only reads inline
		// styles; a scoped class wouldn't unit-assert).
		expect(body).toHaveClass("select-text");
	});

	it("falls back to raw text when no rendered HTML is present", () => {
		const { container } = render(ThreadCard, {
			props: {
				comment,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});
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

		render(ThreadCard, {
			props: {
				comment: withReply,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.getByText("fixed")).toBeInTheDocument();
		expect(screen.getByText("agent")).toBeInTheDocument();
	});

	it("renders the root's own channel attribution in the card header", () => {
		// A reply's channel chip has always rendered; the root's never did.
		// Agent-originated roots are spec-deferred (every root is `human` in
		// practice today), so this overrides the fixture to cover
		// the gap while it's cheap, ahead of that channel shipping.
		const agentRoot: Thread = { ...comment, channel: "agent" };

		const { container } = render(ThreadCard, {
			props: {
				comment: agentRoot,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		const chip = container.querySelector(".comment-card-channel");
		expect(chip).toBeInTheDocument();
		expect(chip).toHaveTextContent("agent");
	});

	it("collapses to the last three replies with an expand control, then shows all on click", async () => {
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

		render(ThreadCard, {
			props: {
				comment: fiveReplies,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.queryByText("reply 1")).not.toBeInTheDocument();
		expect(screen.queryByText("reply 2")).not.toBeInTheDocument();
		expect(screen.getByText("reply 3")).toBeInTheDocument();
		expect(screen.getByText("reply 4")).toBeInTheDocument();
		expect(screen.getByText("reply 5")).toBeInTheDocument();

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

		render(ThreadCard, {
			props: {
				comment: threeReplies,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
	});

	it("shows the thread's current state in a chip", () => {
		const dismissed: Thread = { ...comment, state: "dismissed" };

		render(ThreadCard, {
			props: {
				comment: dismissed,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.getByText("dismissed")).toBeInTheDocument();
	});

	it("offers done/dismiss for an open thread and calls onstatechange with the target state", async () => {
		const onstatechange = vi.fn();
		render(ThreadCard, {
			props: {
				comment,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange,
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		await fireEvent.click(screen.getByText("Mark done"));
		expect(onstatechange).toHaveBeenCalledWith("c1", "done");

		await fireEvent.click(screen.getByText("Dismiss"));
		expect(onstatechange).toHaveBeenCalledWith("c1", "dismissed");

		expect(screen.queryByText("Reopen")).not.toBeInTheDocument();
	});

	it("offers only Reopen for a done thread", async () => {
		const done: Thread = { ...comment, state: "done" };
		const onstatechange = vi.fn();
		render(ThreadCard, {
			props: {
				comment: done,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange,
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.queryByText("Mark done")).not.toBeInTheDocument();
		expect(screen.queryByText("Dismiss")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByText("Reopen"));
		expect(onstatechange).toHaveBeenCalledWith("c1", "open");
	});

	it("offers Reopen among the actions for an addressed thread, and never a control that claims addressed", () => {
		const addressed: Thread = { ...comment, state: "addressed" };
		render(ThreadCard, {
			props: {
				comment: addressed,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.getByText("Reopen")).toBeInTheDocument();
		expect(screen.getByText("Mark done")).toBeInTheDocument();
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
		const buttonLabels = screen
			.getAllByRole("button")
			.map((b) => b.textContent);
		expect(buttonLabels.some((t) => /address/i.test(t ?? ""))).toBe(false);
	});

	it("offers Edit for a human reply and calls onreplyedit with its id and new text", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		const onreplyedit = vi.fn();
		render(ThreadCard, {
			props: {
				comment: humanReply,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit,
				ondeletereply: () => {},
			},
		});

		await fireEvent.click(screen.getByText("Edit reply"));
		const textarea = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
		expect(textarea.value).toBe("original");
		await fireEvent.input(textarea, { target: { value: "corrected" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(onreplyedit).toHaveBeenCalledWith("r1", "corrected");
	});

	it("submits the typed reply via onreply and clears the composer", async () => {
		const onreply = vi.fn();
		render(ThreadCard, {
			props: {
				comment,
				onedit: () => {},
				ondelete: () => {},
				onreply,
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		const textarea = screen.getByLabelText("Reply") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "sounds good" } });
		await fireEvent.click(screen.getByText("Reply"));

		expect(onreply).toHaveBeenCalledWith("c1", "sounds good");
		expect(textarea.value).toBe("");
	});

	it("does not offer Edit for an agent reply", () => {
		const agentReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		render(ThreadCard, {
			props: {
				comment: agentReply,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.queryByText("Edit reply")).not.toBeInTheDocument();
	});

	it("offers Delete for every reply and calls ondeletereply with its id once confirmed", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(true);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		const ondeletereply = vi.fn();
		render(ThreadCard, {
			props: {
				comment: withReply,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply,
			},
		});

		await fireEvent.click(screen.getByText("Delete reply"));
		await flush();

		expect(ask).toHaveBeenCalledTimes(1);
		expect(ondeletereply).toHaveBeenCalledWith("r1");
	});

	it("does not call ondeletereply when the reply-delete confirmation is cancelled", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(false);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		const ondeletereply = vi.fn();
		render(ThreadCard, {
			props: {
				comment: withReply,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply,
			},
		});

		await fireEvent.click(screen.getByText("Delete reply"));
		await flush();

		expect(ask).toHaveBeenCalledTimes(1);
		expect(ondeletereply).not.toHaveBeenCalled();
	});

	// Once the owning review is published, the store refuses to delete a
	// thread or a reply (criterion 12) — offering the control anyway just
	// buys a round trip to the same refusal, so it's hidden instead.
	it("offers Delete for an unpublished thread and hides it once the review is published", async () => {
		const { rerender } = render(ThreadCard, {
			props: {
				comment,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.getByText("Delete")).toBeInTheDocument();

		await rerender({
			comment: { ...comment, published: true },
			onedit: () => {},
			ondelete: () => {},
			onreply: () => {},
			onstatechange: () => {},
			onreplyedit: () => {},
			ondeletereply: () => {},
		});

		expect(screen.queryByText("Delete")).not.toBeInTheDocument();
	});

	it("hides Delete reply once the owning review is published", () => {
		const published: Thread = {
			...comment,
			published: true,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		render(ThreadCard, {
			props: {
				comment: published,
				onedit: () => {},
				ondelete: () => {},
				onreply: () => {},
				onstatechange: () => {},
				onreplyedit: () => {},
				ondeletereply: () => {},
			},
		});

		expect(screen.queryByText("Delete reply")).not.toBeInTheDocument();
	});
});
