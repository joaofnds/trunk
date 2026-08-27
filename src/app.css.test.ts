import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_HEIGHT, UNIT } from "./lib/chrome-heights";
import { FIXED_ROW_HEIGHTS } from "./lib/diff-rows";
import { ROW_HEIGHT } from "./lib/graph-constants";

/* jsdom renders no scrollbars, so these read the stylesheet as text. They guard
   the contract src/lib/scrollbar-activity.ts drives; the proof that it renders
   is a WKWebView screenshot, not this file. */
const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

describe("app.css scrollbars", () => {
	it("paints the thumb from the property the tracker sets, not a fixed color", () => {
		expect(css).toMatch(
			/^::-webkit-scrollbar-thumb \{[^}]*background: var\(--scrollbar-thumb\);/m,
		);
		expect(css).toMatch(/^\t--color-scrollbar-thumb: oklch\(/m);
	});

	it("registers --scrollbar-thumb as transparent, so a pane at rest shows nothing", () => {
		expect(css).toMatch(
			/@property --scrollbar-thumb \{[^}]*syntax: "<color>";[^}]*initial-value: transparent;/,
		);
	});

	it("leaves the track transparent, so a pane with nothing to scroll paints nothing", () => {
		expect(css).toMatch(
			/^::-webkit-scrollbar-track \{\n\tbackground: transparent;\n\}/m,
		);
	});

	it("declares no state-based reveal, which WebKit does not repaint", () => {
		expect(css).not.toMatch(/:hover::-webkit-scrollbar/);
	});
});

describe("app.css lengths", () => {
	const unit = css.match(/^\t--u: (\d+)px;$/m)?.[1];
	const lengths = [
		...css.matchAll(/^\t(--[\w-]+): calc\((\d+) \* var\(--u\)\);$/gm),
	];

	function multiple(name: string) {
		return Number(lengths.find(([, token]) => token === name)?.[2]);
	}

	it("states the unit the constants are built from", () => {
		expect(unit).toBe(String(UNIT));
	});

	it("expresses every declared length as a whole number of units", () => {
		const declared = [
			...css.matchAll(
				/^\t(--(?:space|row|bar|topbar|control|graph|sidebar|right|refs|counter)[\w-]*): ([^;]+);$/gm,
			),
		];
		const offScale = declared.filter(
			([, , value]) =>
				value !== "0" && !/^calc\(\d+ \* var\(--u\)\)$/.test(value),
		);

		expect(offScale.map(([line]) => line.trim())).toEqual([]);
	});

	it("gives the virtualized bars and rows the heights their constants assume", () => {
		expect(multiple("--bar-h") * UNIT).toBe(BAR_HEIGHT);
		expect(multiple("--row-h") * UNIT).toBe(ROW_HEIGHT);
	});

	it("gives the diff pane's fixed header rows that same bar height", () => {
		expect(FIXED_ROW_HEIGHTS.fileHeader).toBe(BAR_HEIGHT);
		expect(FIXED_ROW_HEIGHTS.hunkHeader).toBe(BAR_HEIGHT);
	});
});
