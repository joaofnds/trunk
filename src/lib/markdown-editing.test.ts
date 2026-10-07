import { describe, expect, it } from "vitest";
import {
	continueList,
	linkSelection,
	pasteAsLink,
	prefixLines,
	type TextEdit,
	wrapSelection,
} from "./markdown-editing.js";

// A field is written as its text with the selection marked: `|` for a caret,
// `[` and `]` around selected text.
function field(marked: string) {
	const caret = marked.indexOf("|");
	if (caret >= 0) {
		const value = marked.slice(0, caret) + marked.slice(caret + 1);
		return { value, selectionStart: caret, selectionEnd: caret };
	}
	const start = marked.indexOf("[");
	const end = marked.indexOf("]") - 1;
	const value = marked.replace("[", "").replace("]", "");
	return { value, selectionStart: start, selectionEnd: end };
}

function marked(value: string, edit: TextEdit): string {
	const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
	if (edit.selectionStart === edit.selectionEnd) {
		return `${next.slice(0, edit.selectionStart)}|${next.slice(edit.selectionStart)}`;
	}
	return `${next.slice(0, edit.selectionStart)}[${next.slice(edit.selectionStart, edit.selectionEnd)}]${next.slice(edit.selectionEnd)}`;
}

function apply(
	edit: (f: ReturnType<typeof field>) => TextEdit | null,
	before: string,
): string | null {
	const f = field(before);
	const result = edit(f);
	return result && marked(f.value, result);
}

describe("continueList", () => {
	it.each([
		["- one|", "- one\n- |"],
		["* one|", "* one\n* |"],
		["  - nested|", "  - nested\n  - |"],
		["1. one|", "1. one\n2. |"],
		["9) nine|", "9) nine\n10) |"],
		["- [x] done|", "- [x] done\n- [ ] |"],
	])("continues %j as the next item", (before, after) => {
		expect(apply(continueList, before)).toBe(after);
	});

	it("carries the text after the caret into the new item", () => {
		expect(apply(continueList, "- one| two")).toBe("- one\n- |two");
	});

	it("ends the list on an empty item, leaving the line blank", () => {
		expect(apply(continueList, "- one\n- |")).toBe("- one\n|");
	});

	it("ends a task list on an empty task", () => {
		expect(apply(continueList, "- [ ] |")).toBe("|");
	});

	it("leaves a line that is no list item to the plain newline", () => {
		expect(apply(continueList, "plain|")).toBeNull();
	});

	it("leaves a selection to the plain newline", () => {
		expect(apply(continueList, "- [one]")).toBeNull();
	});

	it("leaves a caret inside the marker to the plain newline", () => {
		expect(apply(continueList, "|- one")).toBeNull();
	});
});

describe("wrapSelection", () => {
	it("wraps the selected text and keeps it selected", () => {
		expect(apply((f) => wrapSelection(f, "**"), "a [bold] word")).toBe(
			"a **[bold]** word",
		);
	});

	it("puts the caret between the marks when nothing is selected", () => {
		expect(apply((f) => wrapSelection(f, "`"), "run |")).toBe("run `|`");
	});

	it("unwraps text the marks already surround", () => {
		expect(apply((f) => wrapSelection(f, "_"), "an _[aside]_")).toBe(
			"an [aside]",
		);
	});
});

describe("linkSelection", () => {
	it("makes the selected text a link and selects the url to type over", () => {
		expect(apply(linkSelection, "see [the docs]")).toBe(
			"see [the docs]([url])",
		);
	});

	it("opens an empty link with the caret in its text", () => {
		expect(apply(linkSelection, "see |")).toBe("see [|](url)");
	});
});

describe("prefixLines", () => {
	it("prefixes every line the selection touches", () => {
		expect(apply((f) => prefixLines(f, "- "), "[one\ntwo]")).toBe(
			"[- one\n- two]",
		);
	});

	it("numbers the lines of an ordered list", () => {
		expect(apply((f) => prefixLines(f, "1. "), "[one\ntwo]")).toBe(
			"[1. one\n2. two]",
		);
	});

	it("quotes the line the caret is on", () => {
		expect(apply((f) => prefixLines(f, "> "), "said |so")).toBe("[> said so]");
	});

	it("removes the prefix when every line already has it", () => {
		expect(apply((f) => prefixLines(f, "> "), "[> one\n> two]")).toBe(
			"[one\ntwo]",
		);
	});
});

describe("pasteAsLink", () => {
	it("links the selected text to a pasted url", () => {
		expect(
			apply((f) => pasteAsLink(f, "https://example.com"), "see [this]"),
		).toBe("see [this](https://example.com)|");
	});

	it("leaves a paste with nothing selected to the plain paste", () => {
		expect(
			apply((f) => pasteAsLink(f, "https://example.com"), "see |"),
		).toBeNull();
	});

	it("leaves pasted text that is no url to the plain paste", () => {
		expect(apply((f) => pasteAsLink(f, "some words"), "see [this]")).toBeNull();
	});
});
