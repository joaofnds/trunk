import { afterEach, describe, expect, it } from "vitest";
import { selectedCode } from "./text-selection.js";

afterEach(() => {
	document.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

function selectCode(
	lines: string,
	start: number,
	end: number,
	backward = false,
) {
	document.body.innerHTML = `<div data-code-selection>${lines}</div>`;
	const anchor = document.querySelector("[data-start]")?.firstChild;
	const focus = document.querySelector("[data-end]")?.firstChild;
	const selection = document.getSelection();
	if (!anchor || !focus || !selection)
		throw new Error("Missing selection fixture");

	if (backward) selection.setBaseAndExtent(focus, end, anchor, start);
	else selection.setBaseAndExtent(anchor, start, focus, end);

	return selectedCode(selection);
}

describe(selectedCode, () => {
	it.each([false, true])(
		"copies only the selected split column in either direction (%s)",
		(backward) => {
			const result = selectCode(
				`<div><span data-code-line="old">oldFirst</span><span data-code-line="new" data-start>  newFirst\n</span></div>
			<div><span data-code-line="old">oldMiddle</span><span data-code-line="new">\n</span></div>
			<div><span data-code-line="old">oldLast</span><span data-code-line="new" data-end>newLast</span></div>`,
				1,
				3,
				backward,
			);

			expect(result?.text()).toBe(" newFirst\n\nnew");
		},
	);

	it("keeps indentation, a selected line break, and zero characters at the next line start", () => {
		const result = selectCode(
			`<div><span>7</span><span data-code-line data-start>\t    first&#13;&#10;</span></div>
			<div><span>8</span><span data-code-line data-end>second</span></div>`,
			0,
			0,
		);

		expect(result?.text()).toBe("\t    first\n");
	});

	it("keeps the starting column when the drag ends over an empty cell", () => {
		const result = selectCode(
			`<div><span data-code-line="old" data-start>first\n</span><span data-code-line="new">other first\n</span></div>
			<div><span data-code-line="old">second\n</span><span data-code-line="new">other second\n</span></div>
			<div><span data-end> </span><span data-code-line="new">other last\n</span></div>`,
			1,
			0,
		);

		expect(result?.text()).toBe("irst\nsecond\n");
	});

	it("clamps a drag beyond the left column at the end of its source line", () => {
		const result = selectCode(
			`<div data-split-code-row><span data-code-line="old" data-start>first\n</span><span data-code-line="new">other first\n</span></div>
			<div data-split-code-row><span data-code-line="old"><span>second\n</span></span><span data-code-line="new" data-end>other second\n</span></div>`,
			1,
			3,
		);

		expect(result?.text()).toBe("irst\nsecond");
	});

	it("leaves a selection ending in prose to native copy", () => {
		const result = selectCode(
			`<span data-code-line data-start>source</span><p data-prose-selection data-end>comment</p>`,
			0,
			4,
		);

		expect(result).toBeUndefined();
	});
});
