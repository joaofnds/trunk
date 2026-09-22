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

	describe("ref pills", () => {
		it("truncates an overlong label and collapses the refs past the first into a badge", async () => {
			const { svg } = await mountGraph(loadExport("lane-10-two-remotes"));

			expect(pillTexts(svg)).toEqual(["origin/m…", "+1", "main"]);
		});
	});

	describe("the dashed WIP connection", () => {
		it("splits at each of the three unpulled rows sharing its column", async () => {
			const { svg } = await mountGraph(loadExport("lane-01-behind-only"), 1);

			expect(dashedPaths(svg).length).toBe(4);
		});
	});
});
