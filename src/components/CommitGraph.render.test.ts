import { beforeAll, describe, expect, it } from "vitest";
import {
	dashedPaths,
	dots,
	expectMatchesGolden,
	goldenNames,
	laneOffset,
	loadExport,
	mountGraph,
	pillTexts,
	renderVariant,
	renderVariants,
	shapeOf,
	warmGraphComponent,
} from "../__tests__/helpers/graph-render";
import { BADGE_HEIGHT, COLUMN_PADDING_X } from "../lib/graph-constants.js";

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

			// One character shorter than it read while the layout reserved 20px for
			// a badge the renderer drew 26px wide: the label now fits the room it
			// really has.
			expect(pillTexts(svg)).toEqual(["origin/…", "+1", "main"]);
		});

		// The label was sized against the badge width the layout reserved, and the
		// badge drew wider, so it ran past the room the pill was given, toward the
		// lanes.
		it("keeps the +N badge inside the Branch/Tag column's padding", async () => {
			const { svg } = await mountGraph(loadExport("lane-10-two-remotes"));

			const [badge] = [...svg.querySelectorAll(".overlay-pills rect")].filter(
				(rect) => Number(rect.getAttribute("height")) === BADGE_HEIGHT,
			);
			const right =
				Number(badge.getAttribute("x")) + Number(badge.getAttribute("width"));

			expect(right).toBeLessThanOrEqual(laneOffset(svg) - 2 * COLUMN_PADDING_X);
		});

		// A column narrower than a pill, which the budget reaches on a narrow list,
		// left the icon, the label and the badge painting over the lanes and
		// taking the pointer there.
		it("cuts what a pill draws at the Branch/Tag column's padding", async () => {
			const { svg } = await mountGraph(loadExport("lane-10-two-remotes"));

			const label = svg.querySelector(".overlay-pills foreignObject");
			const clip = label?.closest("[clip-path]")?.getAttribute("clip-path");
			const id = /url\(#(.+)\)/.exec(clip ?? "")?.[1];
			const bound = svg.querySelector(`clipPath[id="${id}"] rect`);

			expect(Number(bound?.getAttribute("width"))).toBe(
				laneOffset(svg) - 2 * COLUMN_PADDING_X,
			);
		});
	});

	describe("the dashed WIP connection", () => {
		it("splits at each of the three unpulled rows sharing its column", async () => {
			const { svg } = await mountGraph(loadExport("lane-01-behind-only"), 1);

			expect(dashedPaths(svg).length).toBe(4);
		});
	});
});
