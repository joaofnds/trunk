import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aReply } from "../__tests__/helpers/thread-fixture.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import ThreadReplies from "./ThreadReplies.svelte";

const reply = aReply({ id: "r1", text: "original", channel: "human" });

describe("ThreadReplies", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not clear a replacement edit draft when the first save resolves", async () => {
		let settleFirst!: () => void;
		const onreplyedit = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settleFirst = resolve;
				}),
		);
		const firstSession = createThreadEditorSession();
		const replacementSession = createThreadEditorSession();
		const props = {
			replies: [reply],
			published: false,
			onreplyedit,
			onreplydelete: vi.fn(),
			editorSession: firstSession,
		};
		const view = render(ThreadReplies, { props });

		await fireEvent.click(screen.getByText("Edit reply"));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "edit for first card" },
		});
		await fireEvent.click(screen.getByText("Save"));

		await view.rerender({
			replies: [reply],
			published: false,
			onreplyedit,
			onreplydelete: props.onreplydelete,
			editorSession: replacementSession,
		});
		await fireEvent.click(screen.getByText("Edit reply"));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "edit for replacement card" },
		});

		settleFirst();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"edit for replacement card",
		);
	});
});
