import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
		   Both spellings are the same bar and owe the same rule. */
		const barHeight =
			/var\(--(?:bar-h|topbar-h|row-h|control-h|diff-(?:file|hunk)-header-height)\)|\{(?:BAR_HEIGHT|ROW_HEIGHT)\}px/;
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
