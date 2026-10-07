import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CommentEditor from "./CommentEditor.svelte";

function renderEditor(
	overrides: Partial<{
		text: string;
		submitDisabled: boolean;
		onescape: () => void;
		collapsible: boolean;
	}> = {},
) {
	const calls: string[] = [];
	render(CommentEditor, {
		props: {
			text: "",
			label: "Comment",
			placeholder: "Leave a comment",
			submitLabel: "Comment",
			submitDisabled: false,
			onsubmit: () => calls.push("submit"),
			oncancel: () => calls.push("cancel"),
			...overrides,
		},
	});
	const field = screen.getByRole("textbox", {
		name: "Comment",
	}) as HTMLTextAreaElement;
	return { calls, field };
}

async function type(field: HTMLTextAreaElement, marked: string) {
	const start = marked.indexOf("[");
	const value = marked.replace("[", "").replace("]", "");
	await fireEvent.input(field, { target: { value } });
	if (start >= 0) field.setSelectionRange(start, marked.indexOf("]") - 1);
	else field.setSelectionRange(value.length, value.length);
}

describe("CommentEditor", () => {
	it.each([
		["Cmd+Enter", { metaKey: true }],
		["Ctrl+Enter", { ctrlKey: true }],
	])("submits on %s", async (_, modifier) => {
		const { calls, field } = renderEditor({ text: "looks good" });

		await fireEvent.keyDown(field, { key: "Enter", ...modifier });

		expect(calls).toEqual(["submit"]);
	});

	it("keeps a plain Enter for a new line", async () => {
		const { calls, field } = renderEditor({ text: "first line" });

		const typed = await fireEvent.keyDown(field, { key: "Enter" });

		expect(typed).toBe(true);
		expect(calls).toEqual([]);
	});

	it("continues a list on Enter", async () => {
		const { field } = renderEditor();
		await type(field, "- one");

		await fireEvent.keyDown(field, { key: "Enter" });

		expect(field.value).toBe("- one\n- ");
	});

	it("keeps Shift+Enter a plain new line inside a list", async () => {
		const { field } = renderEditor();
		await type(field, "- one");

		const typed = await fireEvent.keyDown(field, {
			key: "Enter",
			shiftKey: true,
		});

		expect(typed).toBe(true);
		expect(field.value).toBe("- one");
	});

	it.each([
		["b", "**"],
		["i", "_"],
		["e", "`"],
	])("wraps the selection on Cmd+%s", async (key, mark) => {
		const { field } = renderEditor();
		await type(field, "a [word]");

		await fireEvent.keyDown(field, { key, metaKey: true });

		expect(field.value).toBe(`a ${mark}word${mark}`);
	});

	it("links the selection on Cmd+K, without reaching the app's shortcuts", async () => {
		const { field } = renderEditor();
		await type(field, "see [docs]");
		const reached: string[] = [];
		const listener = (event: KeyboardEvent) => reached.push(event.key);
		window.addEventListener("keydown", listener);

		await fireEvent.keyDown(field, { key: "k", metaKey: true });

		window.removeEventListener("keydown", listener);
		expect(field.value).toBe("see [docs](url)");
		expect(reached).toEqual([]);
	});

	it.each([
		["Digit8", "- one"],
		["Digit7", "1. one"],
		["Period", "> one"],
	])("prefixes the line on Cmd+Shift+%s", async (code, after) => {
		const { field } = renderEditor();
		await type(field, "one");

		await fireEvent.keyDown(field, {
			key: "x",
			code,
			metaKey: true,
			shiftKey: true,
		});

		expect(field.value).toBe(after);
	});

	it("links the selection to a pasted url", async () => {
		const { field } = renderEditor();
		await type(field, "see [this]");

		await fireEvent.paste(field, {
			clipboardData: { getData: () => "https://example.com" },
		});

		expect(field.value).toBe("see [this](https://example.com)");
	});

	it("submits from its button", async () => {
		const { calls } = renderEditor({ text: "looks good" });

		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		expect(calls).toEqual(["submit"]);
	});

	it("cancels from its button", async () => {
		const { calls } = renderEditor({ text: "looks good" });

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(calls).toEqual(["cancel"]);
	});

	it("takes the focus when it opens", () => {
		const { field } = renderEditor();
		expect(field).toHaveFocus();
	});

	it("grows with its text", async () => {
		const { field } = renderEditor();

		await type(field, "one\ntwo\nthree");

		expect(field.parentElement).toHaveAttribute(
			"data-value",
			"one\ntwo\nthree",
		);
	});

	describe("when submitting is disabled", () => {
		it("ignores Cmd+Enter", async () => {
			const { calls, field } = renderEditor({ submitDisabled: true });

			await fireEvent.keyDown(field, { key: "Enter", metaKey: true });

			expect(calls).toEqual([]);
		});
	});

	describe("when Escape is pressed", () => {
		it("hands it to the host", async () => {
			const escaped: string[] = [];
			const { field } = renderEditor({
				onescape: () => escaped.push("escape"),
			});

			await fireEvent.keyDown(field, { key: "Escape" });

			expect(escaped).toEqual(["escape"]);
		});

		it("lets go of the focus when the host takes nothing", async () => {
			const { field } = renderEditor();

			await fireEvent.keyDown(field, { key: "Escape" });

			expect(field).not.toHaveFocus();
		});
	});

	describe("when collapsible", () => {
		it("waits for a click to take the focus", () => {
			const { field } = renderEditor({ collapsible: true });
			expect(field).not.toHaveFocus();
		});

		it("rests without its actions", () => {
			renderEditor({ collapsible: true });
			expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		});

		it("opens its actions once the field takes the focus", async () => {
			const { field } = renderEditor({ collapsible: true });

			await fireEvent.focusIn(field);

			expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		it("keeps its actions open while it holds text", () => {
			renderEditor({ collapsible: true, text: "half a thought" });
			expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
		});
	});
});
