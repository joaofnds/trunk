import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { assert, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { FakeIntersectionObserver } from "../__tests__/helpers/fake-intersection-observer.js";
import { SCHEDULER } from "../lib/scheduler.js";
import MergeOutput from "./MergeOutput.svelte";
import MergeText from "./MergeText.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("keeps the typed result visible when an earlier syntax reply arrives", async () => {
	const first = Promise.withResolvers<unknown>();
	const clock = new FakeScheduler();
	const currentText = "<tag> & 🧭";
	vi.mocked(invoke)
		.mockReturnValueOnce(first.promise)
		.mockResolvedValueOnce({
			1: [
				{
					start: 0,
					end: currentText.length,
					syntax_class: "syn-string",
					emphasized: false,
				},
			],
		});
	const view = render(MergeOutput, {
		props: {
			filePath: "theme.ts",
			text: "old",
			readonly: false,
			lineHeight: 18,
			oninput: vi.fn(),
			onscroll: vi.fn(),
		},
		context: new Map([[SCHEDULER, clock]]),
	});
	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith("highlight_merge_output", {
			filePath: "theme.ts",
			text: "old",
		}),
	);
	await view.rerender({ text: currentText });
	const output = screen.getByRole("textbox", { name: "Merge output" });
	expect(output).toHaveValue(currentText);
	first.resolve({
		1: [{ start: 0, end: 3, syntax_class: "syn-keyword", emphasized: false }],
	});
	await waitFor(() => expect(clock.pending).toBe(1));
	expect(view.container.querySelector("pre")).toBeNull();
	clock.flush();
	await tick();
	await waitFor(() =>
		expect(view.container.querySelector(".syn-string")?.textContent).toBe(
			currentText,
		),
	);
	expect(view.container.querySelector("tag")).toBeNull();
	expect(output).toHaveValue(currentText);
});

it("keeps surrounding lines painted during an edit and mirrors native newlines", async () => {
	const clock = new FakeScheduler();
	vi.mocked(invoke).mockResolvedValue({
		1: [{ start: 0, end: 3, syntax_class: "syn-keyword", emphasized: false }],
		3: [{ start: 0, end: 3, syntax_class: "syn-number", emphasized: false }],
	});
	const view = render(MergeOutput, {
		props: {
			filePath: "theme.ts",
			text: "let\r\nbbb\r123",
			readonly: false,
			lineHeight: 18,
			oninput: vi.fn(),
			onscroll: vi.fn(),
		},
		context: new Map([[SCHEDULER, clock]]),
	});
	await waitFor(() =>
		expect(view.container.querySelector(".syn-number")?.textContent).toBe(
			"123",
		),
	);
	const mirror = view.container.querySelector("pre");
	expect(invoke).toHaveBeenCalledWith("highlight_merge_output", {
		filePath: "theme.ts",
		text: "let\nbbb\n123",
	});
	await view.rerender({ text: "let\nnew line\nxxx\n123" });
	expect(view.container.querySelector("pre")).toBe(mirror);
	expect(mirror?.querySelector(".syn-keyword")?.textContent).toBe("let");
	expect(mirror?.querySelector(".syn-number")?.textContent).toBe("123");
	expect(mirror?.textContent).toBe("let\nnew line\nxxx\n123\u200b");
});

it.each(["line\n".repeat(1000), "x".repeat(128 * 1024 + 1)])(
	"keeps oversized results editable without requesting syntax",
	async (text) => {
		vi.mocked(invoke).mockClear();
		render(MergeOutput, {
			filePath: "theme.ts",
			text,
			readonly: false,
			lineHeight: 18,
			oninput: vi.fn(),
			onscroll: vi.fn(),
		});
		await tick();
		expect(screen.getByRole("textbox")).toHaveValue(text);
		expect(invoke).not.toHaveBeenCalled();
	},
);

it("learns that the output grammar is unavailable once for the file", async () => {
	const clock = new FakeScheduler();
	vi.mocked(invoke).mockReset().mockResolvedValue(null);
	const view = render(MergeOutput, {
		props: {
			filePath: "notes.md",
			text: "first",
			readonly: false,
			lineHeight: 18,
			oninput: vi.fn(),
			onscroll: vi.fn(),
		},
		context: new Map([[SCHEDULER, clock]]),
	});
	await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
	await view.rerender({ text: "first edit" });
	clock.flush();
	await tick();
	expect(invoke).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("textbox")).toHaveValue("first edit");
});

it("preserves the selected text when toggling soft wrap", async () => {
	const text = "first line\nsecond line";
	const view = render(MergeOutput, {
		filePath: "notes.txt",
		text,
		readonly: false,
		lineHeight: 18,
		oninput: vi.fn(),
		onscroll: vi.fn(),
	});
	const editor = screen.getByRole<HTMLTextAreaElement>("textbox");
	editor.setSelectionRange(2, 7, "backward");

	await view.rerender({ wordWrap: true });

	expect(editor.wrap).toBe("soft");
	expect(editor.value).toBe(text);
	expect([
		editor.selectionStart,
		editor.selectionEnd,
		editor.selectionDirection,
	]).toEqual([2, 7, "backward"]);
});

it("marks whitespace in plain text while retaining its tabs and trailing spaces", async () => {
	vi.mocked(invoke).mockResolvedValue(null);
	const text = "a \tb \t\r\n";
	const view = render(MergeOutput, {
		filePath: "notes.txt",
		text,
		readonly: false,
		lineHeight: 18,
		oninput: vi.fn(),
		onscroll: vi.fn(),
	});

	await view.rerender({ showInvisibles: true });

	const mirror = view.container.querySelector("pre");
	expect(mirror?.getAttribute("aria-hidden")).toBe("true");
	expect(mirror?.textContent).toBe("a \tb \t\n\u200b");
	expect(
		Array.from(view.container.querySelectorAll("[data-glyph]"), (el) =>
			el.getAttribute("data-glyph"),
		),
	).toEqual(["·", "→", "·", "→"]);
	expect(mirror?.querySelectorAll(".trailing-ws")).toHaveLength(2);
	expect(screen.getByRole("textbox")).toHaveValue("a \tb \t\n");
});

function firstObserved(parent: Element): Element | undefined {
	return Array.from(parent.querySelectorAll("span")).find((el) =>
		FakeIntersectionObserver.observes(el),
	);
}

async function revealFirstChunk(parent: Element): Promise<Element> {
	await tick();
	const first = firstObserved(parent);
	assert.isDefined(first);

	let visible: Element | undefined = first;
	while (visible) {
		FakeIntersectionObserver.enter(visible);
		await tick();
		visible = firstObserved(visible);
	}
	return first;
}

it("decorates the visible part of an oversized line and releases marks that scroll away", async () => {
	const text = "a ".repeat(66_000);
	vi.mocked(invoke).mockClear();
	const view = render(MergeOutput, {
		filePath: "notes.txt",
		text,
		readonly: false,
		lineHeight: 18,
		wordWrap: true,
		showInvisibles: true,
		oninput: vi.fn(),
		onscroll: vi.fn(),
	});
	const mirror = view.container.querySelector("pre");
	assert.isNotNull(mirror);
	const first = await revealFirstChunk(mirror);

	const painted = mirror?.querySelectorAll("[data-glyph]").length ?? 0;
	expect(painted).toBeGreaterThan(0);
	expect(painted).toBeLessThan(text.length / 2);
	expect(mirror?.querySelector(".trailing-ws")).toBeNull();
	expect(mirror?.textContent).toBe(`${text}\u200b`);

	FakeIntersectionObserver.leave(first);
	await tick();

	expect(mirror?.querySelector("[data-glyph]")).toBeNull();
	expect(screen.getByRole("textbox")).toHaveValue(text);
	expect(invoke).not.toHaveBeenCalled();
});

it("bounds marker nodes for a long source token with whitespace before more source code", async () => {
	const text = " \t".repeat(10_000);
	const view = render(MergeText, {
		text,
		showInvisibles: true,
		trailingStart: text.length,
	});
	const markers = () => view.container.querySelectorAll("[data-glyph]");

	expect(markers().length).toBeLessThan(1024);
	await revealFirstChunk(view.container);

	expect(markers().length).toBeGreaterThan(0);
	expect(markers().length).toBeLessThan(1024);
	expect(view.container.querySelector(".trailing-ws")).toBeNull();
	expect(view.container.textContent).toBe(text);
});

it("keeps the visible syntax and whitespace in an ordinary multiline output", async () => {
	const line = "a \t".repeat(50);
	const text = Array<string>(600).fill(line).join("\n");
	vi.mocked(invoke).mockResolvedValue({
		1: [
			{ start: 0, end: 3, syntax_class: "syn-comment", emphasized: false },
			{
				start: 3,
				end: line.length,
				syntax_class: "syn-string",
				emphasized: false,
			},
		],
	});
	const view = render(MergeOutput, {
		filePath: "theme.ts",
		text,
		readonly: false,
		lineHeight: 18,
		showInvisibles: true,
		oninput: vi.fn(),
		onscroll: vi.fn(),
	});
	const mirror = view.container.querySelector("pre");
	assert.isNotNull(mirror);

	await revealFirstChunk(mirror);
	await waitFor(() =>
		expect(mirror.querySelector(".syn-comment")?.textContent).toBe("a \t"),
	);

	expect(mirror.querySelectorAll("[data-glyph]")).toHaveLength(100);
	expect(mirror.querySelectorAll(".trailing-ws")).toHaveLength(2);
	expect(mirror.querySelector(".syn-string")?.textContent).toBe(line.slice(3));
	expect(mirror.textContent).toBe(`${text}\u200b`);
});
