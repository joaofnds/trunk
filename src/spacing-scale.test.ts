import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src");

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return svelteFiles(full);
		return entry.name.endsWith(".svelte") ? [full] : [];
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

const namedPart = /^(0|auto|var\(--[\w-]+\)|@(?:px)?)$/;

/** A Svelte interpolation and a `calc()` off the unit are each one opaque value
 *  however many spaces they hold, so both are masked before the shorthand is
 *  split into its sides. Any other `calc()` stays raw and fails. */
const mask = (value: string) =>
	value
		.replace(/\{[^}]*\}/g, "@")
		.replace(/calc\(\s*\d+\s*\*\s*var\(--u\)\s*\)/g, "@");

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
		const barHeight =
			/var\(--(?:bar-h|topbar-h|row-h|control-h|diff-(?:file|hunk)-header-height)\)/;
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
				if (barHeight.test(body) && /border-(?:bottom|top): /.test(body)) {
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
