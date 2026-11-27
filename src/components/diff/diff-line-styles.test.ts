import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* The three source views share DiffLineText. The AAA argument for the
   word patch rests on one rule in its stylesheet: text
   on a patch is --color-diff-text, whatever its syntax class or marker role.
   jsdom does not cascade a scoped <style>, and scripts/contrast/re-audit-verify.mjs
   measures --color-diff-text on the patch without knowing the views put it
   there, so this reads the stylesheets as text, the way app.css.test.ts does.
   The scoped rule outranks global syntax colors. It wins its ties with
   .invisible-char::before and .trailing-ws::before by source order. */

const css = readFileSync(
	resolve(process.cwd(), "src/components/diff/DiffLineText.svelte"),
	"utf8",
);

function lastIndexOfAll(css: string, pattern: RegExp): number {
	const indices = [...css.matchAll(pattern)].map((m) => m.index);
	if (indices.length === 0) throw new Error(`no match for ${pattern}`);
	return Math.max(...indices);
}

describe("DiffLineText styles", () => {
	const patchText = css.match(
		/\.word-add,\s*\.word-delete,\s*\.word-add::before,\s*\.word-delete::before\s*\{([^}]*)\}/,
	);

	it("draws everything on a word patch in the primary diff color", () => {
		expect(patchText).not.toBeNull();
		expect(patchText?.[1]).toMatch(/color:\s*var\(--color-diff-text\)/);
	});

	it("places that rule after every color rule it ties with on specificity", () => {
		const ruleAt = patchText?.index ?? -1;
		expect(ruleAt).toBeGreaterThanOrEqual(0);
		expect(lastIndexOfAll(css, /^\.invisible-char::before \{/gm)).toBeLessThan(
			ruleAt,
		);
		expect(lastIndexOfAll(css, /\.trailing-ws::before \{/g)).toBeLessThan(
			ruleAt,
		);
	});

	it("keeps the patch color under trailing whitespace instead of stacking a third tint", () => {
		expect(css).toMatch(
			/\.word-add\.trailing-ws\s*\{\s*background-color:\s*var\(--color-diff-word-add-bg\)/,
		);
		expect(css).toMatch(
			/\.word-delete\.trailing-ws\s*\{\s*background-color:\s*var\(--color-diff-word-delete-bg\)/,
		);
	});
});
