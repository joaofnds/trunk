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

	/** Every `--token: value;` in `:root`, including the ones biome wraps across
	 *  lines. Matching only single-line declarations left `--counter-gutter` and
	 *  `--dialog-drop` outside every guard here — whether a token was checked came
	 *  down to whether its line was long enough for the formatter to break it.
	 *  Whitespace inside the value is collapsed so a wrapped calc() compares the
	 *  same as an unwrapped one. */
	function declarations(): [string, string, string][] {
		return [...css.matchAll(/^\t(--[\w-]+):\s([^;]+);/gm)].map(
			([line, name, value]) => [
				line,
				name,
				value
					.replace(/\s+/g, " ")
					.replace(/\(\s+/g, "(")
					.replace(/\s+\)/g, ")")
					.trim(),
			],
		);
	}

	it("expresses every declared length as a whole number of units", () => {
		const declared = declarations().filter(
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
		const unread = declarations()
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

	/* WCAG 2.2 SC 2.5.8 asks for 24 CSS px. The sidebar's toggles and the slots that
	   hold their column both read this token, so the number lives here rather than
	   restated as a literal at each site. */
	it("gives the minimum hit target the 24px WCAG 2.2 asks for", () => {
		expect(multiple("--target-min") * UNIT).toBe(24);
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

/* indexOf returns -1 for a missing needle, and -1 loses every ordering
   comparison silently. An ordering test must know it found both rules. */
function ruleIndex(needle: string): number {
	const i = css.indexOf(needle);
	if (i < 0) throw new Error(`rule not found in app.css: ${needle}`);
	return i;
}

describe("rendered markdown word marks", () => {
	/* A rendered mark sits alone on the page, with no row tint under it, so it
	   carries the change by itself: a tint at the same 2:1 step the source-view
	   patch has against its line, plus a strike or underline in the mark's own
	   hue so the mark survives grayscale. The ratios are measured by
	   scripts/contrast/re-audit-verify.mjs, not here. */
	it("colors the underline with the add/delete hue, not the text color", () => {
		const addRule = css.match(/\.md-word-add\s*\{([^}]*)\}/)?.[1] ?? "";
		const deleteRule = css.match(/\.md-word-delete\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(addRule).toMatch(/text-decoration-color:\s*var\(--ok\)/);
		expect(deleteRule).toMatch(/text-decoration-color:\s*var\(--err\)/);
	});

	/* The rule is the hue, not the weight. A pinned thickness read heavy across
	   the long marked runs a prose edit produces, so both marks keep the
	   browser's own hairline: it tracks font size and zoom, and neither mark can
	   drift heavier than the other. */
	it("pins no decoration weight on either mark", () => {
		const addRule = css.match(/\.md-word-add\s*\{([^}]*)\}/)?.[1] ?? "";
		const deleteRule = css.match(/\.md-word-delete\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(addRule).not.toMatch(/text-decoration-thickness/);
		expect(deleteRule).not.toMatch(/text-decoration-thickness/);
	});

	it("draws everything on a rendered mark in the primary diff color", () => {
		/* At 38% no other hue in the theme clears AAA on the mark. The rule
		   reaches descendants so a marked link or code span does not keep its
		   own color, and it comes after every .markdown-body color rule it ties
		   with on specificity (the .syn-* set), so source order makes it win. */
		const rule = css.match(
			/\.markdown-body \.md-word-delete,\s*\.markdown-body \.md-word-add,\s*\.markdown-body \.md-word-delete \*,\s*\.markdown-body \.md-word-add \*\s*\{([^}]*)\}/,
		)?.[1];
		expect(rule).toBeDefined();
		expect(rule).toMatch(/color:\s*var\(--color-diff-text\)/);

		const markRule = ruleIndex(".markdown-body .md-word-delete,");
		const synRules = [...css.matchAll(/\.markdown-body \.syn-[a-z]+ \{/g)].map(
			(m) => m.index,
		);
		expect(synRules.length).toBeGreaterThan(0);
		expect(Math.max(...synRules)).toBeLessThan(markRule);
	});

	/* An image carries no text, so an inline mark around one paints its
	   background over the line box and leaves the picture itself untinted: the
	   reader saw a coloured bar above the old diagram and below the new one,
	   with neither image marked. A mark holding nothing but an image lays out
	   as a block instead, so the wash sits behind the whole picture the way the
	   split columns tint an image's block. */
	it("lays out an image-only mark as a block so its wash covers the image", () => {
		const rule = css.match(
			/\.md-word-delete:has\(> img:only-child\),\s*\.md-word-add:has\(> img:only-child\)\s*\{([^}]*)\}/,
		)?.[1];

		expect(rule).toBeDefined();
		expect(rule).toMatch(/display:\s*block/);
	});

	/* The reader sees one whole picture added or removed, which is what a
	   tinted block is, so an image-only mark takes the block tint itself: one
	   rule per state carrying both selectors. Asserted as shared structure
	   rather than as two rules holding equal values, because equal values are
	   what drifted — the mark inherited --color-md-word-*-bg, calibrated for a
	   few marked words inside a line, and flooded the diagram. */
	it("tints an image-only mark with the block tint rule itself", () => {
		const sharedRule = (
			cls: "md-added" | "md-removed",
			mark: "add" | "delete",
		) =>
			css.match(
				new RegExp(
					`\\n\\.${cls},\\n\\.md-word-${mark}:has\\(> img:only-child\\) \\{([^}]*)\\}`,
				),
			)?.[1];

		const added = sharedRule("md-added", "add");
		const removed = sharedRule("md-removed", "delete");

		expect(added).toBeDefined();
		expect(removed).toBeDefined();
		expect(added).toMatch(/background:\s*var\(--color-diff-add-bg\)/);
		expect(added).toMatch(
			/box-shadow:\s*inset 3px 0 0 var\(--color-diff-add\)/,
		);
		expect(removed).toMatch(/background:\s*var\(--color-diff-delete-bg\)/);
		expect(removed).toMatch(
			/box-shadow:\s*inset 3px 0 0 var\(--color-diff-delete\)/,
		);
	});

	/* The word-mark wash must not reach an image-only mark by any route: no
	   later rule may set one back onto it. */
	it("never washes an image-only mark with a word-mark token", () => {
		const imageRules = [
			...css.matchAll(
				/\.md-word-(?:add|delete):has\(> img:only-child\)[^{]*\{([^}]*)\}/g,
			),
		].map((m) => m[1]);

		expect(imageRules.length).toBeGreaterThan(0);
		for (const rule of imageRules) {
			expect(rule).not.toMatch(/--color-md-word/);
		}
	});
});

describe("rendered markdown list item tints", () => {
	/* The rail suppression has to outrank the block tint AFTER the build merges
	   that tint's two selectors into :is(.md-added, .md-word-add:has(> img...)).
	   :is() takes the specificity of its most specific argument, so the merged
	   selector scores (0,2,0) and a plain `li.md-added` at (0,1,1) loses: the
	   rail survived into the shipped build while every source read said it was
	   suppressed. Asserted as a doubled class, which is what buys the specificity
	   — the suppression must stay at least (0,2,1). */
	it("suppresses the item rail specifically enough to survive the :is() merge", () => {
		const suppression = css.match(
			/(li\.md-added[^,{]*,\s*li\.md-removed[^,{]*)\{([^}]*)\}/,
		);

		expect(suppression).not.toBeNull();
		expect(suppression?.[2]).toMatch(/box-shadow:\s*none/);
		expect(suppression?.[1]).toMatch(/li\.md-added\.md-added/);
		expect(suppression?.[1]).toMatch(/li\.md-removed\.md-removed/);
	});

	/* A tinted item of the outermost list means the same thing to the reader as
	   a tinted whole block: this line was added. It has to look the same too,
	   and it did not — the item's highlight stopped at the list's border box,
	   leaving .rendered-block's horizontal padding dark at both ends, so a
	   full-width wash sat directly above a band inset from each edge. The reach
	   is --md-prose-inset, which the container sets to the value it pads with;
	   a literal length here would be the drift that produced the bug. */
	it("bleeds an outermost-list item's tint across the prose inset", () => {
		const before = css.match(
			/\.markdown-body > ul > li\.md-added::before,[^{]*\{([^}]*)\}/,
		)?.[1];
		const box = css.match(
			/\.markdown-body > ul > li\.md-added,[^{]*\{([^}]*)\}/,
		)?.[1];

		expect(before).toBeDefined();
		expect(before).toMatch(
			/left:\s*calc\(-1 \* \(var\(--md-list-gutter\) \+ var\(--md-prose-inset, 0px\)\)\)/,
		);
		expect(before).toMatch(
			/width:\s*calc\(var\(--md-list-gutter\) \+ var\(--md-prose-inset, 0px\)\)/,
		);

		expect(box).toBeDefined();
		expect(box).toMatch(
			/margin-right:\s*calc\(-1 \* var\(--md-prose-inset, 0px\)\)/,
		);
		expect(box).toMatch(/padding-right:\s*var\(--md-prose-inset, 0px\)/);
	});

	/* The negative margin is given back as padding, so the content box ends
	   where it did and the left side is never touched: WKWebView anchors the
	   outside ::marker to the li border box, and a bullet out of line with its
	   untinted siblings is the regression this pairing exists to avoid. */
	it("never shifts a tinted item's left edge, so the bullet stays in line", () => {
		const box = css.match(
			/\.markdown-body > ul > li\.md-added,[^{]*\{([^}]*)\}/,
		)?.[1];

		expect(box).toBeDefined();
		expect(box).not.toMatch(/margin-left/);
		expect(box).not.toMatch(/padding-left/);
	});

	/* A nested item keeps its highlight starting at its own bullet: that inset
	   is what says the item belongs to the sub-list and not to the pane. Only
	   a direct child of .markdown-body's own list gets the full bleed. */
	it("leaves a nested item's tint at its own gutter", () => {
		const bleedSelectors = css.match(
			/([^}]*)\{[^}]*left:\s*calc\(-1 \* \(var\(--md-list-gutter\) \+ var\(--md-prose-inset, 0px\)\)\)/,
		)?.[1];

		expect(bleedSelectors).toBeDefined();
		for (const selector of (bleedSelectors ?? "").split(",")) {
			if (selector.trim()) {
				expect(selector.trim()).toMatch(/^\.markdown-body > (?:ul|ol) > li\./);
			}
		}
	});

	/* The default is no bleed, so a .markdown-body host that does not inset its
	   prose (a comment body) reaches its own content edge and nowhere further.
	   It has to be a var() fallback rather than a declaration: .markdown-body
	   declaring its own default overwrites the container's value for every
	   descendant, which is exactly where these rules read it, and the bleed
	   collapses to zero while the container still pads. That is a bug the
	   stylesheet reads as correct, so it is pinned here. */
	it("takes the zero inset as a fallback, never as its own declaration", () => {
		const prose = css.match(/\.markdown-body \{([^}]*)\}/)?.[1];

		expect(prose).toBeDefined();
		expect(prose).not.toMatch(/--md-prose-inset:/);

		const reads = [...css.matchAll(/var\(--md-prose-inset([^)]*)\)/g)];
		expect(reads.length).toBeGreaterThan(0);
		for (const [, fallback] of reads) {
			expect(fallback).toBe(", 0px");
		}
	});
});
