import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import { aReply, aStateChange } from "../__tests__/helpers/thread-fixture.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import ThreadReplies from "./ThreadReplies.svelte";

const reply = aReply({ id: "r1", text: "original", channel: "human" });

describe("ThreadReplies", () => {
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
			},
		});

		const items = [...container.querySelectorAll(".thread-replies > li")].map(
			(li) => li.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(items[0]).toContain("before");
		expect(items[1]).toMatch(/^Agent marked addressed in a3f9c21 · /);
		expect(items[2]).toContain("after");
	});

	it("puts a change after the reply written in the same second", () => {
		const { container } = render(ThreadReplies, {
			props: {
				replies: [aReply({ id: "r1", text_html: "fixed it", created_at: 100 })],
				history: [aStateChange({ created_at: 100 })],
				onreplyedit: () => true,
				onreplydelete: () => {},
			},
		});

		const items = container.querySelectorAll(".thread-replies > li");
		expect(items[0].textContent).toContain("fixed it");
		expect(items[1].textContent).toContain("marked addressed");
	});

	it("names a reopen by the person at the keyboard", () => {
		render(ThreadReplies, {
			props: {
				replies: [],
				history: [aStateChange({ state: "open", channel: "human" })],
				onreplyedit: () => true,
				onreplydelete: () => {},
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
					aReply({ id, created_at: n }),
				),
				history: [aStateChange({ created_at: 10 })],
				onreplyedit: () => true,
				onreplydelete: () => {},
			},
		});

		expect(screen.getByText("Show 2 more replies")).toBeInTheDocument();
	});

	it("keeps four replies whole", () => {
		render(ThreadReplies, {
			props: {
				replies: ["r1", "r2", "r3", "r4"].map((id) => aReply({ id })),
				onreplyedit: () => true,
				onreplydelete: () => {},
			},
		});

		expect(screen.queryByText(/Show \d+ more/)).toBeNull();
	});

	it.each(["Edit reply", "Delete reply"])(
		"keeps %s in sight without waiting for the pointer",
		(name) => {
			render(ThreadReplies, {
				props: {
					replies: [reply],
					onreplyedit: () => true,
					onreplydelete: () => {},
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
			},
		});

		const more = screen.getByRole("button", { name: /Show 2 more replies/ });
		expect(
			more.querySelector('[title="Agent (via trunk CLI)"]'),
		).not.toBeNull();
		expect(more.querySelector('[title="You"]')).not.toBeNull();
	});

	it("closes a reply edit once its save succeeds", async () => {
		render(ThreadReplies, {
			props: {
				replies: [reply],
				onreplyedit: () => true,
				onreplydelete: () => {},
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
			editorSession,
		};
		let view = render(ThreadReplies, { props });

		await fireEvent.click(screen.getByText("Show 2 more replies"));
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
