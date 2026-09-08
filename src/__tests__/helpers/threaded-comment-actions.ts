import { fireEvent, render, within } from "@testing-library/svelte";
import { expect, it } from "vitest";
import type {
	addReply as AddReply,
	deleteReply as DeleteReply,
	editReply as EditReply,
	setThreadState as SetThreadState,
} from "../../lib/review-comment-actions.js";
import { aThread } from "./thread-fixture.js";

// Shared behavior for the three diff hosts (FullFileView, HunkView, SplitView):
// each renders a threaded comment via a `viewComments` prop and delegates the
// four reply/state-change actions to ThreadCard, which calls
// review-comment-actions.ts directly. Every host also renders the same
// ThreadCard a second time inside a hidden measurement probe, so `cardScope`
// is the CSS class each host's visible comment row carries, to disambiguate.
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
	actions: {
		addReply: typeof AddReply;
		setThreadState: typeof SetThreadState;
		editReply: typeof EditReply;
		deleteReply: typeof DeleteReply;
	},
) {
	function visibleCard(container: HTMLElement): HTMLElement {
		const card = container.querySelector(`${cardScope} .comment-card`);
		if (!card) throw new Error("no visible comment card");
		return card as HTMLElement;
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

	it("submits a reply via addReply with the repo path", async () => {
		const { container } = render(Component, { props: commentedProps() });
		const card = visibleCard(container);

		const textarea = within(card).getByLabelText(
			"Reply",
		) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "reply text" } });
		await fireEvent.click(within(card).getByText("Reply"));

		expect(actions.addReply).toHaveBeenCalledWith("/repo", "t1", "reply text");
	});

	it("changes the thread's state via setThreadState with the repo path", async () => {
		const { container } = render(Component, { props: commentedProps() });
		const card = visibleCard(container);

		await fireEvent.click(within(card).getByText("Mark done"));

		expect(actions.setThreadState).toHaveBeenCalledWith("/repo", "t1", "done");
	});

	it("edits a reply via editReply with the repo path", async () => {
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

		expect(actions.editReply).toHaveBeenCalledWith("/repo", "r1", "corrected");
	});

	it("deletes a reply via deleteReply with the repo path (no confirmation, inline confirmDelete=false)", async () => {
		const { container } = render(Component, {
			props: commentedWithReplyProps(),
		});
		const card = visibleCard(container);

		await fireEvent.click(within(card).getByText("Delete reply"));

		expect(actions.deleteReply).toHaveBeenCalledWith("/repo", "r1");
	});
}
