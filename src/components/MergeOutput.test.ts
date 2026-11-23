import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { SCHEDULER } from "../lib/scheduler.js";
import MergeOutput from "./MergeOutput.svelte";

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
