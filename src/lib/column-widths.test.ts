import { beforeEach, describe, expect, it } from "vitest";
import { makeCommit, makeRef } from "../__tests__/helpers/factories";
import {
	AUTHOR_AVATAR_WIDTH,
	authorContentWidth,
	columnFloors,
	columnWidthDeclarations,
	columnWidthProperty,
	DEFAULT_WIDTHS,
	dateContentWidth,
	graphTargetWidth,
	headerMinWidths,
	refContentWidth,
	sanitizeColumnWidths,
	shaContentWidth,
	showsHeaderLabel,
} from "./column-widths.js";
import {
	COLUMN_PADDING_X,
	LANE_WIDTH,
	PILL_FONT_BOLD,
} from "./graph-constants.js";
import { buildRefPillData } from "./ref-pill-data.js";
import { relativeLabel } from "./relative-time.js";
import { resetCache } from "./text-measure.js";
import type { GraphCommit } from "./types.js";

// A proportional font, faked: digits and round glyphs are wider than the rest,
// so two strings of equal length can still measure differently — as they do on
// screen, and as the date rule depends on. No canvas, no jsdom.
const WIDE_GLYPH = /[0-9mwMW]/;
function measure(text: string): number {
	return [...text].reduce((w, ch) => w + (WIDE_GLYPH.test(ch) ? 10 : 6), 0);
}

const PADDING = 2 * COLUMN_PADDING_X;

describe("authorContentWidth", () => {
	it("fits the longest author name, with room for the avatar", () => {
		const commits = [
			makeCommit({ oid: "a".repeat(40), author_name: "Ada" }),
			makeCommit({ oid: "b".repeat(40), author_name: "Grace Hopper" }),
		];

		expect(authorContentWidth(commits, measure)).toBe(
			measure("Grace Hopper") + PADDING + AUTHOR_AVATAR_WIDTH,
		);
	});

	// The WIP row and stash rows render no author, so measuring their empty or
	// synthetic names would only ever shrink nothing and confuse the reading.
	it("ignores the WIP row", () => {
		const commits = [
			makeCommit({ oid: "__wip__", author_name: "a very long WIP author" }),
			makeCommit({ oid: "b".repeat(40), author_name: "Ada" }),
		];

		expect(authorContentWidth(commits, measure)).toBe(
			measure("Ada") + PADDING + AUTHOR_AVATAR_WIDTH,
		);
	});

	it("ignores stash rows", () => {
		const commits = [
			makeCommit({
				oid: "a".repeat(40),
				author_name: "a very long stash author",
				is_stash: true,
			}),
			makeCommit({ oid: "b".repeat(40), author_name: "Ada" }),
		];

		expect(authorContentWidth(commits, measure)).toBe(
			measure("Ada") + PADDING + AUTHOR_AVATAR_WIDTH,
		);
	});

	describe("when the page holds nothing measurable", () => {
		it("asks for no width", () => {
			expect(authorContentWidth([], measure)).toBe(0);
		});
	});
});

describe("dateContentWidth", () => {
	// The cell shows a relative label that changes as the commit ages, so the
	// column is sized for the widest label the clock can produce — not for
	// whatever it happens to say right now.
	it("fits the widest label the relative clock can produce", () => {
		expect(dateContentWidth(measure)).toBe(measure("12mo ago") + PADDING);
	});

	it("is wider than the label showing at this moment", () => {
		expect(dateContentWidth(measure)).toBeGreaterThan(
			measure("just now") + PADDING,
		);
	});

	// WIDEST_LABELS is hand-maintained beside the formatter that fills the cell.
	// Derive the vocabulary from relativeLabel itself — one label per bucket plus
	// its boundary — so a new or reworded bucket joins this expectation instead of
	// silently clipping the column.
	it("fits every label the formatter can emit", () => {
		const nowMinute = 30_000_000;
		const vocabulary = [
			0, 1, 59, 60, 1439, 1440, 43199, 43200, 525599, 525600, 5_256_000,
		].map((minutesAgo) =>
			relativeLabel((nowMinute - minutesAgo) * 60, nowMinute),
		);

		const widest = Math.max(...vocabulary.map((label) => measure(label)));

		expect(dateContentWidth(measure)).toBe(widest + PADDING);
	});
});

describe("shaContentWidth", () => {
	it("fits a seven-character abbreviated sha", () => {
		expect(shaContentWidth(measure)).toBe(measure("0000000") + PADDING);
	});
});

describe("graphTargetWidth", () => {
	it("fits every lane", () => {
		expect(graphTargetWidth(3, LANE_WIDTH)).toBe(3 * LANE_WIDTH + PADDING);
	});

	it("keeps one lane's width for a graph with no commits", () => {
		expect(graphTargetWidth(0, LANE_WIDTH)).toBe(LANE_WIDTH + PADDING);
	});

	// The header word no longer sets the width: a graph narrower than "Graph"
	// shows the header's icon, so auto-fit is free to size to the lanes alone.
	describe("when the lanes are narrower than the header word", () => {
		it("still fits the lanes rather than the word", () => {
			expect(graphTargetWidth(1, LANE_WIDTH)).toBe(LANE_WIDTH + PADDING);
		});
	});
});

describe("headerMinWidths", () => {
	it("fits each header label plus its padding and breathing room", () => {
		expect(headerMinWidths(measure).author).toBe(
			measure("Author") + 4 * COLUMN_PADDING_X,
		);
	});

	it("covers every resizable column", () => {
		expect(Object.keys(headerMinWidths(measure)).sort()).toEqual([
			"author",
			"date",
			"diff",
			"graph",
			"ref",
			"sha",
		]);
	});
});

describe("columnFloors", () => {
	it("lets the graph shrink to a single lane of commits", () => {
		expect(columnFloors().graph).toBe(LANE_WIDTH + PADDING);
	});

	it("covers every resizable column", () => {
		expect(Object.keys(columnFloors()).sort()).toEqual([
			"author",
			"date",
			"diff",
			"graph",
			"ref",
			"sha",
		]);
	});

	// The floor is what the cell needs to show anything at all, so it must not
	// depend on the header word — that dependency is what kept the graph two
	// lanes wide.
	it("is narrower than the header label needs", () => {
		const floors = columnFloors();
		const labelMins = headerMinWidths(measure);

		for (const column of Object.keys(floors) as (keyof typeof floors)[]) {
			expect(floors[column]).toBeLessThan(labelMins[column]);
		}
	});
});

describe("showsHeaderLabel", () => {
	it("shows the word when the column fits it", () => {
		expect(showsHeaderLabel(100, 50)).toBe(true);
	});

	it("hides the word when the column is narrower than it", () => {
		expect(showsHeaderLabel(30, 50)).toBe(false);
	});

	// At exactly the label's own minimum the word still fits, which is what that
	// minimum means.
	it("shows the word at exactly its minimum", () => {
		expect(showsHeaderLabel(50, 50)).toBe(true);
	});
});

describe("refContentWidth", () => {
	// HEAD's pill renders bold, so a metric that ignores the font cannot tell
	// whether the fit measured it in the font it is drawn in.
	function measureByFont(text: string, font: string): number {
		return measure(text) + (font === PILL_FONT_BOLD ? text.length : 0);
	}

	/** The labels the pills show when the ref column is `width` wide. */
	function pillLabels(commits: GraphCommit[], width: number): string[] {
		const nodes = commits.map((commit, y) => ({
			oid: commit.oid,
			x: 0,
			y,
			colorIndex: 0,
			isMerge: false,
			isBranchTip: false,
			isStash: false,
			isWip: false,
		}));

		return buildRefPillData(nodes, commits, width, measureByFont).map(
			(pill) => pill.truncatedLabel,
		);
	}

	const head = makeRef({ short_name: "main", is_head: true });
	const topic = makeRef({ short_name: "backup-pre-rebase" });
	const topicRemote = makeRef({
		short_name: "origin/backup-pre-rebase",
		ref_type: "RemoteBranch",
	});
	const page = [
		makeCommit({ oid: "a".repeat(40), refs: [head] }),
		makeCommit({ oid: "b".repeat(40), refs: [topic, topicRemote] }),
	];

	beforeEach(resetCache);

	it("gives every pill on the page room for its whole label", () => {
		const width = refContentWidth(page, measureByFont);

		expect(pillLabels(page, width)).toEqual(["main", "backup-pre-rebase"]);
	});

	// A row draws its highest-priority ref and folds the rest into a badge, so
	// the column is sized to that pill, not to the longest name the row holds.
	it("leaves the widest pill no room to spare", () => {
		const width = refContentWidth(page, measureByFont);

		expect(pillLabels(page, width - 1)).not.toContain("backup-pre-rebase");
	});

	it("fits HEAD's pill in the bold font it is drawn in", () => {
		const onlyHead = [
			makeCommit({
				oid: "a".repeat(40),
				refs: [makeRef({ short_name: "backup-pre-rebase", is_head: true })],
			}),
		];

		const width = refContentWidth(onlyHead, measureByFont);

		expect(pillLabels(onlyHead, width)).toEqual(["backup-pre-rebase"]);
	});

	// The WIP row and stash rows draw no pill in this column.
	it.each([
		["the WIP row", { oid: "__wip__" }],
		["a stash row", { oid: "c".repeat(40), is_stash: true }],
	])("ignores %s", (_name, row) => {
		const withRow = [
			...page,
			makeCommit({
				...row,
				refs: [makeRef({ short_name: "a-far-longer-name-than-any-other" })],
			}),
		];

		expect(refContentWidth(withRow, measureByFont)).toBe(
			refContentWidth(page, measureByFont),
		);
	});

	describe("when the page carries no refs", () => {
		it("asks for no width", () => {
			const bare = [makeCommit({ oid: "a".repeat(40) })];

			expect(refContentWidth(bare, measureByFont)).toBe(0);
		});
	});
});

describe("sanitizeColumnWidths", () => {
	const floors = columnFloors();

	it("keeps a width the user could have set", () => {
		const widths = sanitizeColumnWidths({ ...DEFAULT_WIDTHS, author: 180 });

		expect(widths.author).toBe(180);
	});

	it("fills a key the stored layout never had", () => {
		const stored = { ref: 150 };

		expect(sanitizeColumnWidths(stored).sha).toBe(DEFAULT_WIDTHS.sha);
	});

	// Each of these reached the layout before: a NaN width made every drag
	// produce NaN and persisted it, so the column could not be dragged back.
	describe("when the stored value is not a usable width", () => {
		const unusable = [
			["null", null],
			["a string", "120"],
			["NaN", Number.NaN],
			["infinity", Number.POSITIVE_INFINITY],
			["negative", -40],
			["zero", 0],
			["an object", {}],
		] as const;

		it.each(unusable)("falls back to the default for %s", (_name, value) => {
			const stored = { author: value };

			expect(sanitizeColumnWidths(stored).author).toBe(DEFAULT_WIDTHS.author);
		});
	});

	it("raises a width below the column's floor", () => {
		const stored = { author: 2 };

		expect(sanitizeColumnWidths(stored).author).toBe(floors.author);
	});

	// A user width has a floor and no ceiling.
	it("keeps a width however wide the user left it", () => {
		const stored = { graph: 900 };

		expect(sanitizeColumnWidths(stored).graph).toBe(900);
	});

	it("rounds a fractional width to whole pixels", () => {
		const stored = { author: 120.6 };

		expect(sanitizeColumnWidths(stored).author).toBe(121);
	});

	describe("when there is no stored layout at all", () => {
		it("returns the defaults", () => {
			expect(sanitizeColumnWidths(undefined)).toEqual(DEFAULT_WIDTHS);
		});
	});
});

describe("columnWidthDeclarations", () => {
	const widths = {
		ref: 101,
		graph: 102,
		diff: 103,
		author: 104,
		date: 105,
		sha: 106,
	};

	it.each(["ref", "graph", "diff", "author", "date", "sha"] as const)(
		"declares the %s width under that column's property",
		(column) => {
			const style = document.createElement("div").style;

			style.cssText = columnWidthDeclarations(widths);

			expect(style.getPropertyValue(columnWidthProperty(column))).toBe(
				`${widths[column]}px`,
			);
		},
	);
});
