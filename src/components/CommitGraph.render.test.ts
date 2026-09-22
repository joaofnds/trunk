import { beforeAll, describe, expect, it } from "vitest";
import {
	dashedPaths,
	dots,
	expectMatchesGolden,
	goldenNames,
	type LayoutExport,
	laneOffset,
	loadExport,
	mountGraph,
	pillTexts,
	renderVariant,
	renderVariants,
	shapeOf,
	stubTextWidth,
	warmGraphComponent,
} from "../__tests__/helpers/graph-render";
import {
	DEFAULT_WIDTHS,
	FIT_CAPS,
	refContentWidth,
} from "../lib/column-widths.js";
import { BADGE_HEIGHT, COLUMN_PADDING_X } from "../lib/graph-constants.js";

/** The fixture with its first ref renamed, to give the page a ref of that length. */
function withFirstRefNamed(fixture: LayoutExport, name: string): LayoutExport {
	const commits = structuredClone(fixture.layout.commits);
	const [ref] = commits.flatMap((commit) => commit.refs);
	ref.short_name = name;

	return { ...fixture, layout: { ...fixture.layout, commits } };
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

	// The column sat at a fixed 120px for every repository: too narrow for a
	// long branch name, and dead space before the lanes when every ref is short.
	describe("the Branch/Tag column", () => {
		it("fits the widest pill the page carries", async () => {
			const fixture = loadExport("lane-09-branch-point-below-head");

			const { svg } = await mountGraph(fixture);

			expect(laneOffset(svg)).toBe(
				refContentWidth(fixture.layout.commits, stubTextWidth) +
					COLUMN_PADDING_X,
			);
		});

		it("narrows to a page whose refs are all short", async () => {
			const { svg } = await mountGraph(loadExport("lane-01-behind-only"));

			expect(laneOffset(svg)).toBeLessThan(
				DEFAULT_WIDTHS.ref + COLUMN_PADDING_X,
			);
		});

		it("stops at its cap for a ref longer than the cap allows", async () => {
			const fixture = withFirstRefNamed(
				loadExport("lane-09-branch-point-below-head"),
				"backup-pre-update-1.32.0-20260920T004226Z",
			);

			const { svg } = await mountGraph(fixture);

			expect(laneOffset(svg)).toBe(FIT_CAPS.ref + COLUMN_PADDING_X);
		});
	});

	describe("ref pills", () => {
		it("shows the row's first ref whole and folds the rest into a badge", async () => {
			const { svg } = await mountGraph(loadExport("lane-10-two-remotes"));

			expect(pillTexts(svg)).toEqual(["origin/main", "+1", "main"]);
		});

		// The label was sized against the badge width the layout reserved, and the
		// badge drew wider, so at the column's fit it ran past the column's padding
		// toward the lanes.
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
