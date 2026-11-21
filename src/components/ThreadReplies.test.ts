import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import { aReply, aStateChange } from "../__tests__/helpers/thread-fixture.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import ThreadReplies from "./ThreadReplies.svelte";

const reply = aReply({ id: "r1", text: "original", channel: "human" });

describe("ThreadReplies", () => {
	it("dims what the replies say once the thread is dismissed", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [reply],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: true,
			},
		});

		expect(container.querySelector(".thread-replies")).toHaveClass(
			"thread-replies-dismissed",
		);
	});

	it("keeps the replies strong while the thread is not dismissed", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [reply],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		expect(container.querySelector(".thread-replies")).not.toHaveClass(
			"thread-replies-dismissed",
		);
	});

	it("tells a state change between the replies it came between", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [
					aReply({ id: "r1", text_html: "before", created_at: 100 }),
					aReply({ id: "r2", text_html: "after", created_at: 300 }),
				],
				history: [
					aStateChange({
						state: "addressed",
						channel: "agent",
						commit: "a3f9c21e0b8d4f6a9c1e2b3d4f5a6b7c8d9e0f1a",
						created_at: 200,
					}),
				],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		const items = [...container.querySelectorAll(".thread-replies > li")].map(
			(li) => li.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(items[0]).toContain("before");
		expect(items[1]).toMatch(/^Agent marked addressed in a3f9c21 · /);
		expect(items[2]).toContain("after");
	});

	it("tells a follow onto the rewritten commit between the replies it came between", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [
					aReply({ id: "r1", text_html: "before", created_at: 100 }),
					aReply({ id: "r2", text_html: "after", created_at: 300 }),
				],
				follows: [
					{
						from: "d6348df0b8d4f6a9c1e2b3d4f5a6b7c8d9e0f1a2",
						to: "1c0540b0b8d4f6a9c1e2b3d4f5a6b7c8d9e0f1a2",
						created_at: 200,
					},
				],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		const items = [...container.querySelectorAll(".thread-replies > li")].map(
			(li) => li.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(items[0]).toContain("before");
		expect(items[1]).toMatch(/^Followed its commit from d6348df to 1c0540b · /);
		expect(items[2]).toContain("after");
	});

	it("puts a change after the reply written in the same second", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [aReply({ id: "r1", text_html: "fixed it", created_at: 100 })],
				history: [aStateChange({ created_at: 100 })],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		const items = container.querySelectorAll(".thread-replies > li");
		expect(items[0].textContent).toContain("fixed it");
		expect(items[1].textContent).toContain("marked addressed");
	});

	it("puts a follow after a state change from the same second", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [],
				history: [aStateChange({ created_at: 100 })],
				follows: [
					{
						from: "d6348df0b8d4f6a9c1e2b3d4f5a6b7c8d9e0f1a2",
						to: "1c0540b0b8d4f6a9c1e2b3d4f5a6b7c8d9e0f1a2",
						created_at: 100,
					},
				],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		const items = container.querySelectorAll(".thread-replies > li");
		expect(items[0].textContent).toContain("marked addressed");
		expect(items[1].textContent).toContain("Followed its commit");
	});

	it("names a reopen by the person at the keyboard", () => {
		render(ThreadReplies, {
			props: {
				replies: [],
				history: [aStateChange({ state: "open", channel: "human" })],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		expect(screen.getByText("reopened").parentElement).toHaveTextContent(
			/^You reopened/,
		);
	});

	it("counts a state change among the entries it folds away", () => {
		render(ThreadReplies, {
			props: {
				replies: ["r1", "r2", "r3", "r4"].map((id, n) =>
					aReply({ id, created_at: n + 1 }),
				),
				history: [aStateChange({ created_at: 0 })],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		expect(
			screen.getByRole("button", { name: "Show earlier activity (2)" }),
		).toBeInTheDocument();
	});

	it("keeps the newest reply visible through later state changes", () => {
		render(ThreadReplies, {
			props: {
				replies: ["first", "second", "latest"].map((text, created_at) =>
					aReply({ id: text, text_html: text, created_at }),
				),
				history: [3, 4, 5].map((created_at) => aStateChange({ created_at })),
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		expect(screen.getByText("latest")).toBeInTheDocument();
		expect(screen.queryByText("second")).toBeNull();
	});

	it("keeps four replies whole", () => {
		render(ThreadReplies, {
			props: {
				replies: ["r1", "r2", "r3", "r4"].map((id) => aReply({ id })),
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
	});

	it.each(["Edit reply", "Delete reply"])(
		"keeps %s in sight without waiting for the pointer",
		(name) => {
			render(ThreadReplies, {
				props: {
					replies: [reply],
					onreplyedit: () => true,
					onreplydelete: () => {},
					dismissed: false,
				},
			});

			const action = screen.getByRole("button", { name });

			expect(action.closest(".opacity-0")).toBeNull();
		},
	);

	it("shows the faces of the authors it hides", () => {
		render(ThreadReplies, {
			props: {
				replies: [
					aReply({ id: "r1", channel: "agent" }),
					aReply({ id: "r2", channel: "human" }),
					aReply({ id: "r3" }),
					aReply({ id: "r4" }),
					aReply({ id: "r5" }),
				],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		const more = screen.getByRole("button", { name: "Show 2 earlier replies" });
		expect(
			more.querySelector('[title="Agent (via trunk CLI)"]'),
		).not.toBeNull();
		expect(more.querySelector('[title="You"]')).not.toBeNull();
	});

	it("toggles earlier replies from the same focused button", async () => {
		render(ThreadReplies, {
			props: {
				replies: [1, 2, 3, 4, 5].map((number) =>
					aReply({ id: `r${number}`, text_html: `reply ${number}` }),
				),
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});
		const disclosure = screen.getByRole("button", {
			name: "Show 2 earlier replies",
		});
		disclosure.focus();

		await fireEvent.click(disclosure);

		expect(disclosure).toHaveAccessibleName("Hide earlier replies");
		expect(disclosure).toHaveAttribute("aria-expanded", "true");
		expect(disclosure).toHaveFocus();
		expect(screen.getByText("reply 1")).toBeInTheDocument();

		await fireEvent.click(disclosure);

		expect(disclosure).toHaveAccessibleName("Show 2 earlier replies");
		expect(disclosure).toHaveAttribute("aria-expanded", "false");
		expect(disclosure).toHaveFocus();
		expect(screen.queryByText("reply 1")).toBeNull();
		expect(screen.getByText("reply 5")).toBeInTheDocument();
	});

	it("remembers the reader's expanded history for the mounted surface", async () => {
		const replies = [1, 2, 3, 4, 5].map((number) =>
			aReply({ id: `r${number}`, text_html: `reply ${number}` }),
		);
		const editorSession = createThreadEditorSession();
		const props = {
			replies,
			onreplyedit: () => true,
			onreplydelete: () => {},
			dismissed: false,
			editorSession,
		};
		const first = render(ThreadReplies, { props });

		await fireEvent.click(
			screen.getByRole("button", { name: "Show 2 earlier replies" }),
		);
		first.unmount();
		render(ThreadReplies, { props });

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Hide earlier replies" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("keeps the same focused reply editor when a new reply moves it into earlier history", async () => {
		const replies = [1, 2, 3, 4, 5].map((number) =>
			aReply({ id: `r${number}`, text: `reply ${number}` }),
		);
		const props = {
			replies,
			onreplyedit: () => true,
			onreplydelete: () => {},
			dismissed: false,
		};
		const view = render(ThreadReplies, { props });
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Edit reply" })[0],
		);
		const field = screen.getByRole<HTMLTextAreaElement>("textbox", {
			name: "Edit reply",
		});
		field.setSelectionRange(2, 4);
		expect(
			screen.getByRole("button", { name: "Show 2 earlier replies" }),
		).toHaveAttribute("aria-expanded", "false");

		await view.rerender({
			...props,
			replies: [...replies, aReply({ id: "r6", text: "reply 6" })],
		});

		expect(screen.getByRole("textbox", { name: "Edit reply" })).toBe(field);
		expect(field).toHaveValue("reply 3");
		expect(field).toHaveFocus();
		expect([field.selectionStart, field.selectionEnd]).toEqual([2, 4]);
		expect(
			screen.getByRole("button", { name: "Hide earlier replies" }),
		).toHaveAttribute("aria-disabled", "true");
	});

	it("closes a reply edit once its save succeeds", async () => {
		render(ThreadReplies, {
			props: {
				replies: [reply],
				onreplyedit: () => true,
				onreplydelete: () => {},
				dismissed: false,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
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
				onreplyedit,
				onreplydelete: () => {},
				dismissed: false,
				editorSession,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
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
			onreplyedit,
			onreplydelete: () => {},
			dismissed: false,
			editorSession: firstSession,
		};
		const view = render(ThreadReplies, { props });

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "edit for first card" },
		});
		await fireEvent.click(screen.getByText("Save"));

		await view.rerender({
			replies: [reply],
			onreplyedit,
			onreplydelete: props.onreplydelete,
			dismissed: false,
			editorSession: replacementSession,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
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
			aReply({ id: "r4", text: "fourth" }),
			aReply({ id: "r5", text: "newest" }),
		];
		const editorSession = createThreadEditorSession();
		const props = {
			replies,
			onreplyedit: () => true,
			onreplydelete: () => {},
			dismissed: false,
			editorSession,
		};
		let view = render(ThreadReplies, { props });

		await fireEvent.click(
			screen.getByRole("button", { name: "Show 2 earlier replies" }),
		);
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Edit reply" })[0],
		);
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
