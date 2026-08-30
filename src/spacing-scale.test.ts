import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXED_ROW_HEIGHT_VARS } from "./lib/diff-rows.js";

const root = resolve(process.cwd(), "src");

/** Every stylesheet the app ships. app.css converted its own spacing and radii
 *  to tokens too, and nothing was checking that they stayed that way. */
function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return svelteFiles(full);
		return /\.(svelte|css)$/.test(entry.name) ? [full] : [];
	});
}

function offences(pattern: RegExp, allowed: (value: string) => boolean) {
	const found: string[] = [];
	for (const file of svelteFiles(root)) {
		const source = readFileSync(file, "utf8").replace(
			/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g,
			"",
		);
		for (const match of source.matchAll(pattern)) {
			const value = match[match.length - 1].trim();
			if (allowed(value)) continue;
			found.push(`${relative(root, file)}: ${match[0].trim()}`);
		}
	}
	return found;
}

/* `em` is prose, not chrome: `.markdown-body` sizes its paragraph rhythm to the
   text it wraps, which is what an em is for and what the unit scale is not. */
/** Every custom property that declares the height of a band spanning its pane,
 *  read from where it is declared rather than restated: app.css's `:root`
 *  chrome heights, and the diff pane's `FIXED_ROW_HEIGHT_VARS`, which emits its
 *  properties from TS constants. Adding a chrome height token brings it under
 *  this guard with no edit here.
 *
 *  `--control-h` is in: a full-size control sits in a bar and shares its edge,
 *  and this is what caught the toolbar's button group. The two smaller control
 *  heights are deliberately out: a bordered chip loses the same pixel, but the
 *  ~11 sites belong with the button-recipe extraction (TRUNK-50), not here.
 *
 *  Derived by shape rather than by name. An earlier version matched a closed
 *  list of four spellings, so a token whose name was not already in the pattern
 *  was exempt from the guard however it was used — which is the same way every
 *  guard on this card failed before it. `--banded-lg-h` was live and unwatched
 *  under that version. */
const SMALLER_CONTROLS = new Set(["--control-sm-h", "--control-lg-h"]);

function barTokens(): string[] {
	const css = readFileSync(join(root, "app.css"), "utf8");
	const chrome = [...css.matchAll(/^\t(--[\w-]*h): /gm)]
		.map(([, name]) => name)
		.filter((name) => !SMALLER_CONTROLS.has(name));
	const diffRows = [...FIXED_ROW_HEIGHT_VARS.matchAll(/(--[\w-]+):/g)].map(
		([, name]) => name,
	);
	return [...chrome, ...diffRows];
}

const namedPart = /^(0|auto|var\(--[\w-]+\)|[\d.]+em|@(?:px)?)$/;

/** A Svelte interpolation and a `calc()` built only from the scale are each one
 *  opaque value however many spaces they hold, so both are masked before the
 *  shorthand is split into its sides. A `calc()` naming any length the scale
 *  does not own stays raw and fails. */
const onScaleCalc =
	/calc\((?:\s|\d+|\*|\+|-|\/|\(|\)|var\(--(?:u|space-[1-4]|depth(?:,\s*0)?)\))+\)/g;

const mask = (value: string) =>
	value.replace(/\{[^}]*\}/g, "@").replace(onScaleCalc, "@");

describe("spacing scale", () => {
	it("carries no raw pixel value in a gap, padding or margin", () => {
		const raw = offences(
			/\b(?:gap|row-gap|column-gap|(?:padding|margin)(?:-(?:top|right|bottom|left))?): ([^;"\n]+)/g,
			(value) =>
				mask(value)
					.split(/\s+/)
					.every((part) => namedPart.test(part)),
		);

		expect(raw).toEqual([]);
	});

	it("spends no layout on a bar's own rule", () => {
		/* A bar declares its height either from the token or, where the height is
		   also needed by virtualization math, from the constant that mirrors it.
		   Both spellings are the same bar and owe the same rule.

		   The token names are read from where they are declared, not restated
		   here: a list written out by hand is how the merge editor's bar ended up
		   the one site this guard could not see. */
		const barHeight = new RegExp(
			`var\\((?:${barTokens().join("|")})\\)|\\{(?:BAR_HEIGHT|ROW_HEIGHT)\\}px`,
		);
		const raw: string[] = [];
		for (const file of svelteFiles(root)) {
			const source = readFileSync(file, "utf8").replace(
				/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g,
				"",
			);
			const blocks = [
				...source.matchAll(/\{\n((?:(?!\n[ \t]*\}).)*?)\n[ \t]*\}/gs),
				...source.matchAll(/style="((?:[^"]|\n)*?)"/g),
			];
			for (const [, body] of blocks) {
				if (
					barHeight.test(body) &&
					/border(?:-(?:bottom|top))?: [^;]*\d/.test(body)
				) {
					raw.push(relative(root, file));
				}
			}
		}

		expect([...new Set(raw)]).toEqual([]);
	});

	it("hides no declaration behind a comment the browser will not parse", () => {
		/* A CSS comment is not valid inside an HTML style attribute: the browser
		   drops the comment and every declaration after it, silently. A conflict
		   header lost its height, background and rule this way, while the source
		   still read correctly. */
		const raw: string[] = [];
		for (const file of svelteFiles(root)) {
			const source = readFileSync(file, "utf8");
			for (const [, body] of source.matchAll(/style="((?:[^"]|\n)*?)"/g)) {
				if (body.includes("/*")) raw.push(relative(root, file));
			}
		}

		expect([...new Set(raw)]).toEqual([]);
	});

	it("reaches for no Tailwind radius step beside the token", () => {
		const raw: string[] = [];
		for (const file of svelteFiles(root)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/g,
			)) {
				raw.push(`${relative(root, file)}: ${match[0]}`);
			}
		}

		expect(raw).toEqual([]);
	});

	it("paints every corner with the one radius or a pill", () => {
		const raw = offences(
			/border-radius: ([^;"\n]+)/g,
			(value) =>
				value === "50%" ||
				value
					.split(/\s+/)
					.every(
						(part) => part === "0" || /^var\(--radius(-pill)?\)$/.test(part),
					),
		);

		expect(raw).toEqual([]);
	});
});
