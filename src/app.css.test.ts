import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_HEIGHT, UNIT } from "./lib/chrome-heights";
import { FIXED_ROW_HEIGHTS } from "./lib/diff-rows";
import { ROW_HEIGHT } from "./lib/graph-constants";
import { THUMB_PROPERTY } from "./lib/scrollbar-activity.js";

/* jsdom renders no scrollbars, so these read the stylesheet as text. They guard
   the contract src/lib/scrollbar-activity.ts drives; the proof that it renders
   is a WKWebView screenshot, not this file. */
const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

/* WCAG relative luminance from an oklch(L C H) triple, via OKLab -> linear sRGB
   -> gamma sRGB, the same pipeline scripts/contrast/contrast.mjs uses on the
   full token graph. Kept local and minimal (a fixed oklch triple, not the
   general var()/color-mix() resolver) so this test stays inside svelte-check's
   strict-mode program; contrast.mjs is plain, untyped JS and pulls 43 implicit-
   any errors in when imported into it. */
function oklchLuminance(l: number, c: number, h: number): number {
	const hr = (h * Math.PI) / 180;
	const a = c * Math.cos(hr);
	const b = c * Math.sin(hr);
	const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = l - 0.0894841775 * a - 1.291485548 * b;
	const [lin, min, sin] = [l_ ** 3, m_ ** 3, s_ ** 3];
	const linear = [
		4.0767416621 * lin - 3.3077115913 * min + 0.2309699292 * sin,
		-1.2684380046 * lin + 2.6097574011 * min - 0.3413193965 * sin,
		-0.0041960863 * lin - 0.7034186147 * min + 1.707614701 * sin,
	];
	const toGamma = (x: number) => {
		const v = Math.min(Math.max(x, 0), 1);
		return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
	};
	const [r, g, bl] = linear.map(toGamma);
	return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function oklchToken(name: string): [number, number, number] {
	const match = css.match(
		new RegExp(`${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`),
	);
	if (!match) throw new Error(`token ${name} not found as a plain oklch()`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrastRatio(fg: string, bg: string): number {
	const l1 = oklchLuminance(...oklchToken(fg));
	const l2 = oklchLuminance(...oklchToken(bg));
	const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
	return (hi + 0.05) / (lo + 0.05);
}

describe("app.css scrollbars", () => {
	it("paints the thumb from the property the tracker sets, not a fixed color", () => {
		expect(css).toMatch(
			new RegExp(
				`::-webkit-scrollbar-thumb\\s*\\{[^}]*background:\\s*var\\(${THUMB_PROPERTY}\\)`,
			),
		);
	});

	it("declares the thumb color as a theme token", () => {
		expect(css).toMatch(/--color-scrollbar-thumb:\s*oklch\(/);
	});

	it("clears WCAG 1.4.11's 3:1 for non-text UI against both surfaces it thumbs over", () => {
		expect(
			contrastRatio("--color-scrollbar-thumb", "--bg-0"),
		).toBeGreaterThanOrEqual(3);
		expect(
			contrastRatio("--color-scrollbar-thumb", "--bg-1"),
		).toBeGreaterThanOrEqual(3);
	});

	it("registers the tracker's property as transparent, so a pane at rest shows nothing", () => {
		expect(css).toMatch(
			new RegExp(
				`@property\\s+${THUMB_PROPERTY}\\s*\\{[^}]*syntax:\\s*"<color>"`,
			),
		);
		expect(css).toMatch(
			new RegExp(
				`@property\\s+${THUMB_PROPERTY}\\s*\\{[^}]*initial-value:\\s*transparent`,
			),
		);
	});

	it("leaves the track transparent, so a pane with nothing to scroll paints nothing", () => {
		expect(css).toMatch(
			/::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/,
		);
	});

	it("declares no state-based reveal, which WebKit does not repaint", () => {
		expect(css).not.toMatch(/:hover::-webkit-scrollbar/);
	});

	it("keeps the horizontal bar at zero height, so it never steals viewport clientHeight", () => {
		expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*height:\s*0;/);
	});

	it("lets the vertical hide overrides in SplitView, RenderedDiff and TabBar keep outranking the bare rule", () => {
		const [, body] = css.match(/::-webkit-scrollbar\s*\{([^}]*)\}/) ?? [];
		expect(body).toBeDefined();
		expect(body).not.toMatch(/!important/);
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
