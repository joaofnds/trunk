import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import { aReply } from "../__tests__/helpers/thread-fixture.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import ThreadReplies from "./ThreadReplies.svelte";

const reply = aReply({ id: "r1", text: "original", channel: "human" });

describe("ThreadReplies", () => {
	it("closes a reply edit once its save succeeds", async () => {
		render(ThreadReplies, {
			props: {
				replies: [reply],
				published: false,
				onreplyedit: () => true,
				onreplydelete: () => {},
			},
		});

		await fireEvent.click(screen.getByText("Edit reply"));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "saved edit" },
		});
		await fireEvent.click(screen.getByText("Save"));
		await tick();

		expect(
			screen.queryByRole("textbox", { name: "Edit reply" }),
		).not.toBeInTheDocument();
	});

	it("keeps a reply edit open when the save is refused", async () => {
		const edits: [string, string][] = [];
		const onreplyedit = async (id: string, text: string) => {
			edits.push([id, text]);
			return false;
		};
		const editorSession = createThreadEditorSession();
		render(ThreadReplies, {
			props: {
				replies: [reply],
				published: false,
				onreplyedit,
				onreplydelete: () => {},
				editorSession,
			},
		});

		await fireEvent.click(screen.getByText("Edit reply"));
		const textarea = screen.getByRole("textbox", { name: "Edit reply" });
		await fireEvent.input(textarea, { target: { value: "refused edit" } });
		await fireEvent.click(screen.getByText("Save"));
		await tick();

		expect(edits).toEqual([["r1", "refused edit"]]);
		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"refused edit",
		);
	});

	it("does not clear a replacement edit draft when the first save resolves", async () => {
		let settleFirst!: (saved: boolean) => void;
		const onreplyedit = () =>
			new Promise<boolean>((resolve) => {
				settleFirst = resolve;
			});
		const firstSession = createThreadEditorSession();
		const replacementSession = createThreadEditorSession();
		const props = {
			replies: [reply],
			published: false,
			onreplyedit,
			onreplydelete: () => {},
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

		settleFirst(true);
		await tick();
		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"edit for replacement card",
		);
	});

	it("keeps an older edited reply visible after the list remounts", async () => {
		const replies = [
			aReply({ id: "r1", text: "oldest" }),
			aReply({ id: "r2", text: "second" }),
			aReply({ id: "r3", text: "third" }),
			aReply({ id: "r4", text: "newest" }),
		];
		const editorSession = createThreadEditorSession();
		const props = {
			replies,
			published: false,
			onreplyedit: () => true,
			onreplydelete: () => {},
			editorSession,
		};
		let view = render(ThreadReplies, { props });

		await fireEvent.click(screen.getByText("Show 1 more reply"));
		await fireEvent.click(screen.getAllByText("Edit reply")[0]);
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "keep this older edit" },
		});

		view.unmount();
		view = render(ThreadReplies, { props });

		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"keep this older edit",
		);
		view.unmount();
	});
});
