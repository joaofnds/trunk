import { fireEvent, render, within } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import type { safeInvoke as SafeInvoke } from "../../lib/invoke.js";
import { aThread } from "./thread-fixture.js";

// Shared behavior for the three diff hosts (FullFileView, HunkView, SplitView):
// each renders a threaded comment via a `viewComments` prop and delegates the
// four reply/state-change actions to ThreadCard, which calls
// review-comment-actions.ts, which calls safeInvoke. Asserting on safeInvoke
// (the real IPC boundary) instead of on review-comment-actions.ts's exports
// matches the pattern already used for this same wiring in ReviewPanel.test.ts
// and CommitDetail.test.ts. Every host also renders the same ThreadCard a
// second time inside a hidden measurement probe, so `cardScope` is the CSS
// class each host's visible comment row carries, to disambiguate.
// `Component` borrows `render`'s own first-parameter type rather than
// re-declaring one: the three hosts' concrete `.svelte` imports already have
// the exact type `render` wants, and re-typing it generically (rather than
// simply forwarding the type) loses that.
export function describeThreadedCommentActions(
	Component: Parameters<typeof render>[0],
	defaultProps: (
		overrides?: Record<string, unknown>,
	) => Record<string, unknown>,
	cardScope: string,
	safeInvoke: typeof SafeInvoke,
) {
	beforeEach(() => {
		vi.mocked(safeInvoke).mockClear();
	});

	function visibleCard(container: HTMLElement): HTMLElement {
		const card = container.querySelector(`${cardScope} .comment-card`);
		if (!card) throw new Error("no visible comment card");
		return card as HTMLElement;
	}

	function calledCommands(): string[] {
		return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
	}

	function callArgs(cmd: string): Record<string, unknown> | undefined {
		const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
		return call?.[1] as Record<string, unknown> | undefined;
	}

	function commentedProps() {
		const commented = aThread({
			id: "t1",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "FullFile",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
		});
		return defaultProps({ viewComments: [commented] });
	}

	function commentedWithReplyProps() {
		const commented = aThread({
			id: "t1",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "FullFile",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
			replies: [
				{
					id: "r1",
					text: "original",
					text_html: "",
					channel: "human",
					created_at: 1_000,
				},
			],
		});
		return defaultProps({ viewComments: [commented] });
	}

	it("submits a reply via add_reply with the repo path", async () => {
		const { container } = render(Component, { props: commentedProps() });
		const card = visibleCard(container);

		const textarea = within(card).getByLabelText(
			"Reply",
		) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "reply text" } });
		await fireEvent.click(within(card).getByText("Reply"));

		expect(calledCommands()).toContain("add_reply");
		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "t1",
			text: "reply text",
		});
	});

	it("changes the thread's state via set_thread_state with the repo path", async () => {
		const { container } = render(Component, { props: commentedProps() });
		const card = visibleCard(container);

		await fireEvent.click(within(card).getByText("Mark done"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "t1",
			next: "done",
		});
	});

	it("edits a reply via edit_reply with the repo path", async () => {
		const { container } = render(Component, {
			props: commentedWithReplyProps(),
		});
		const card = visibleCard(container);

		await fireEvent.click(within(card).getByText("Edit reply"));
		const textarea = within(card).getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "corrected" } });
		await fireEvent.click(within(card).getByText("Save"));

		expect(calledCommands()).toContain("edit_reply");
		expect(callArgs("edit_reply")).toEqual({
			path: "/repo",
			id: "r1",
			text: "corrected",
		});
	});

	it("deletes a reply via delete_reply with the repo path (no confirmation, inline confirmDelete=false)", async () => {
		const { container } = render(Component, {
			props: commentedWithReplyProps(),
		});
		const card = visibleCard(container);

		await fireEvent.click(within(card).getByText("Delete reply"));

		expect(calledCommands()).toContain("delete_reply");
		expect(callArgs("delete_reply")).toEqual({ path: "/repo", id: "r1" });
	});
}
