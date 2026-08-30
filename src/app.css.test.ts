import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_HEIGHT, ROW_HEIGHT, treeIndent, UNIT } from "./lib/chrome-heights";
import { FIXED_ROW_HEIGHTS } from "./lib/diff-rows";
import { THUMB_CLASS } from "./lib/scrollbar-activity.js";

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
	it("hides the native scrollbar on every axis, so it never reserves layout space", () => {
		expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*none;/);
	});

	it("styles the overlay thumb class the tracker paints, from the theme token", () => {
		expect(css).toMatch(
			new RegExp(
				`\\.${THUMB_CLASS}\\s*\\{[^}]*background:\\s*var\\(--color-scrollbar-thumb\\)`,
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

	it("keeps the overlay thumb out of the scroller's own layout", () => {
		expect(css).toMatch(
			new RegExp(`\\.${THUMB_CLASS}\\s*\\{[^}]*position:\\s*fixed;`),
		);
	});

	it("leaves the thumb able to take a press, since dragging it is how a pane scrolls", () => {
		expect(css).toMatch(
			new RegExp(`\\.${THUMB_CLASS}\\s*\\{[^}]*pointer-events:\\s*auto;`),
		);
	});

	it("paints the same 5px sliver it always did, so taking a press changed no widths", () => {
		const [, body] =
			css.match(new RegExp(`\\.${THUMB_CLASS}\\s*\\{([^}]*)\\}`)) ?? [];
		expect(body).toMatch(/width:\s*5px;/);
		expect(body).not.toMatch(/border-(left|right):/);
	});
});

/** Every stylesheet the app ships, app.css included — a token is read from a
 *  component or from another rule in app.css itself, and both count. */
function svelteAndCssSources(): string[] {
	const root = resolve(process.cwd(), "src");
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return walk(full);
			return /\.(svelte|css|ts)$/.test(entry.name) &&
				!entry.name.endsWith(".test.ts")
				? [readFileSync(full, "utf8")]
				: [];
		});
	return walk(root);
}

/** One length: a bare `0`, a single px value, or a `calc()` over the unit. A
 *  shadow is a list of them and an opacity has no unit; neither is on the scale
 *  this guards. */
function isLength(value: string): boolean {
	return /^(?:0|-?[\d.]+px|calc\([^,]*\))$/.test(value.trim());
}

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

	/* Named one by one, because the rule is that a length is on the scale and
	   these are the exceptions. An allowlist of prefixes would let a token
	   reintroduced under a new name — a second bar height, say — pass unread. */
	const offScaleByDesign = new Set([
		"--u", // the unit itself
		"--radius-pill", // a pill is round, not a multiple of anything
	]);

	it("expresses every declared length as a whole number of units", () => {
		const declared = [...css.matchAll(/^\t(--[\w-]+): ([^;]+);$/gm)].filter(
			([, name, value]) => !offScaleByDesign.has(name) && isLength(value),
		);
		/* A whole number of units, optionally plus the single pixel a painted rule
		   costs the surface that draws one. Anything else is off the scale. */
		const onScale = /^calc\(\d+ \* var\(--u\)(?: \+ 1px)?\)$/;
		const offScale = declared.filter(
			([, , value]) => value !== "0" && !onScale.test(value),
		);

		expect(offScale.map(([line]) => line.trim())).toEqual([]);
	});

	it("declares no length token nothing reads", () => {
		const sources = svelteAndCssSources();
		const unread = [...css.matchAll(/^\t(--[\w-]+): ([^;]+);$/gm)]
			.filter(([, , value]) => isLength(value))
			.map(([, name]) => name)
			.filter((name) => !offScaleByDesign.has(name))
			.filter((name) => !sources.some((text) => text.includes(`var(${name})`)));

		expect(unread).toEqual([]);
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

describe("tree row indent", () => {
	it("insets one gutter step, plus four per level of nesting", () => {
		expect(treeIndent(0)).toBe(`${2 * UNIT}px`);
		expect(treeIndent(1)).toBe(`${6 * UNIT}px`);
		expect(treeIndent(3)).toBe(`${14 * UNIT}px`);
	});
});

describe("merge editor conflict header", () => {
	it("adds the pixel its second rule costs, so its band matches a plain bar", () => {
		/* It fences content on both sides, so both rules paint inside the box and
		   the visible band would otherwise be a pixel short of every other bar.
		   The virtualized row model and the CSS must agree on that, or the two
		   panes drift out of alignment with each other. */
		const source = readFileSync(
			resolve(process.cwd(), "src/components/MergeEditor.svelte"),
			"utf8",
		);

		expect(source).toContain("const CONFLICT_HEADER_HEIGHT = BAR_HEIGHT + 1;");
		expect(source).toContain("height: calc(var(--bar-h) + 1px);");
	});
});
