import { describe, expect, it } from "vitest";
import { parseSummary, prefixToneVar } from "./commit-prefix.js";

describe("parseSummary", () => {
	it("splits a plain conventional prefix from the rest", () => {
		expect(parseSummary("fix: bug")).toEqual({
			prefix: "fix",
			scope: "",
			bang: "",
			rest: "bug",
		});
	});

	it("captures the scope", () => {
		expect(parseSummary("feat(api): add sort")).toEqual({
			prefix: "feat",
			scope: "(api)",
			bang: "",
			rest: "add sort",
		});
	});

	it("captures a breaking-change bang", () => {
		expect(parseSummary("refactor(core)!: drop legacy path")).toEqual({
			prefix: "refactor",
			scope: "(core)",
			bang: "!",
			rest: "drop legacy path",
		});
	});

	it.each(["Merge branch 'hotfix/typo' into main", "Initial commit", "WIP"])(
		"leaves a non-conventional summary untouched: %s",
		(summary) => {
			expect(parseSummary(summary)).toEqual({
				prefix: null,
				scope: null,
				bang: null,
				rest: summary,
			});
		},
	);
});

describe("prefixToneVar", () => {
	it.each([
		// Semantic anchors — the hue carries meaning.
		{ prefix: "feat", tone: "var(--ok)" },
		{ prefix: "perf", tone: "var(--ok)" },
		{ prefix: "fix", tone: "var(--warn)" },
		{ prefix: "revert", tone: "var(--err)" },
		{ prefix: "docs", tone: "var(--info)" },
		// Distinct neutral hues, clear of the semantic ones.
		{ prefix: "refactor", tone: "var(--lane-3)" },
		{ prefix: "refine", tone: "var(--lane-2)" },
		{ prefix: "test", tone: "var(--lane-5)" },
		{ prefix: "style", tone: "var(--lane-6)" },
		// Tooling / housekeeping — one shared hue.
		{ prefix: "chore", tone: "var(--lane-1)" },
		{ prefix: "build", tone: "var(--lane-1)" },
		{ prefix: "ci", tone: "var(--lane-1)" },
	])("maps $prefix to $tone", ({ prefix, tone }) => {
		expect(prefixToneVar(prefix)).toBe(tone);
	});

	it.each(["wip", "hotfix", "merge"])(
		"gives an unmapped prefix %s a stable, non-grey lane color",
		(prefix) => {
			const tone = prefixToneVar(prefix);
			expect(tone).not.toBe("var(--fg-3)");
			expect(tone).toMatch(/^var\(--lane-[0-7]\)$/);
			expect(prefixToneVar(prefix)).toBe(tone);
		},
	);
});
