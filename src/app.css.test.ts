import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
