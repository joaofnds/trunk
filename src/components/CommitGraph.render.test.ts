import { beforeAll, describe, expect, it } from "vitest";
import {
	dashedPaths,
	dots,
	expectMatchesGolden,
	goldenNames,
	loadExport,
	mountGraph,
	pillTexts,
	renderVariant,
	renderVariants,
	shapeOf,
	warmGraphComponent,
} from "../__tests__/helpers/graph-render";
import { refContentWidth } from "../lib/column-widths.js";
import { COLUMN_PADDING_X } from "../lib/graph-constants.js";

/** The text metric the render harness stubs in place of a real canvas. */
const WIDE_GLYPH = /[0-9mwMW]/;
const stubMeasure = (text: string): number =>
	[...text].reduce((w, ch) => w + (WIDE_GLYPH.test(ch) ? 10 : 6), 0);

const fixtureCommits = (name: string) => loadExport(name).layout.commits;

/** Where the lanes start, which is the ref column's width plus its padding. */
function laneOffset(svg: SVGSVGElement): number {
	const lanes = svg.querySelector(".overlay-dots");
	const transform = lanes?.getAttribute("transform") ?? "";

	return Number(/translate\((-?[\d.]+),/.exec(transform)?.[1]);
}

describe("CommitGraph", () => {
	beforeAll(warmGraphComponent, 30_000);

	describe("the graph overlay", () => {
		it.each(renderVariants())(
			"matches the committed render golden for $name",
			async (variant) => {
				const { markup } = await renderVariant(variant);

				expectMatchesGolden(variant.name, markup);
			},
		);

		it.each(renderVariants())(
			"renders one dot per row of $name",
			async (variant) => {
				const { dotCount } = await renderVariant(variant);

				expect(dotCount).toBe(variant.rows);
			},
		);

		it("has a golden for every export variant and no others", () => {
			const expected = renderVariants().map((variant) => variant.name);

			expect(goldenNames()).toEqual(expected);
		});
	});

	// One render carrying all four: a WIP row above a stash, above a merge tip,
	// above an ordinary commit. `.claude/rules/commit-graph.md` binds the shapes.
	describe("the node shape ladder", () => {
		const allFourShapes = () => mountGraph(loadExport("stash-14-merge-tip"), 1);

		it("paints the WIP row as a dashed hollow circle", async () => {
			const { svg } = await allFourShapes();

			expect(shapeOf(dots(svg)[0])).toEqual({
				element: "circle",
				fill: "none",
				dash: "3 3",
				strokeWidth: "1.5",
			});
		});

		it("paints a stash as a dashed hollow square", async () => {
			const { svg } = await allFourShapes();

			expect(shapeOf(dots(svg)[1])).toEqual({
				element: "rect",
				fill: "none",
				dash: "3 3",
				strokeWidth: "1.5",
			});
		});

		it("paints a merge as a hollow circle with the merge stroke", async () => {
			const { svg } = await allFourShapes();

			expect(shapeOf(dots(svg)[2])).toEqual({
				element: "circle",
				fill: "var(--bg-1)",
				dash: null,
				strokeWidth: "2",
			});
		});

		it("paints an ordinary commit as a filled circle", async () => {
			const { svg } = await allFourShapes();

			expect(shapeOf(dots(svg)[3])).toEqual({
				element: "circle",
				fill: "var(--lane-0)",
				dash: null,
				strokeWidth: null,
			});
		});
	});

	describe("the Branch/Tag column", () => {
		// It was pinned at its 120px default for every repository: too narrow for a
		// long branch name, and leaving dead space before the lanes for a repo
		// whose refs are all short. Every other sized column fits its content.
		// The lane group's x offset is the column's width plus its padding.
		it("fits the widest ref the page carries rather than a fixed default", async () => {
			const { svg } = await mountGraph(
				loadExport("lane-09-branch-point-below-head"),
			);

			expect(laneOffset(svg)).toBe(
				refContentWidth(
					fixtureCommits("lane-09-branch-point-below-head"),
					stubMeasure,
				) + COLUMN_PADDING_X,
			);
		});

		// A repo whose refs are all short must not keep a wide column: the fixed
		// default was wrong in this direction too, and only ever grew.
		it("shrinks to a page of short refs", async () => {
			const { svg } = await mountGraph(loadExport("lane-01-behind-only"), 1);

			expect(laneOffset(svg)).toBeLessThan(120 + COLUMN_PADDING_X);
		});
	});

	describe("ref pills", () => {
		it("shows the row's first ref and collapses the rest into a badge", async () => {
			const { svg } = await mountGraph(loadExport("lane-10-two-remotes"));

			// Not truncated at all any more: the column auto-fits to the widest pill
			// its page carries, badge included, so the label it used to cut short
			// now has the room it asks for.
			expect(pillTexts(svg)).toEqual(["origin/main", "+1", "main"]);
		});
	});

	describe("the dashed WIP connection", () => {
		it("splits at each of the three unpulled rows sharing its column", async () => {
			const { svg } = await mountGraph(loadExport("lane-01-behind-only"), 1);

			expect(dashedPaths(svg).length).toBe(4);
		});
	});
});
