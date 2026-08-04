import { describe, expect, it } from "vitest";
import { makeCommit } from "../__tests__/helpers/factories";
import {
	AUTHOR_AVATAR_WIDTH,
	authorContentWidth,
	dateContentWidth,
	graphTargetWidth,
	headerMinWidths,
	shaContentWidth,
} from "./column-widths.js";
import { COLUMN_PADDING_X, LANE_WIDTH } from "./graph-constants.js";
import { relativeLabel } from "./relative-time.js";

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
		expect(graphTargetWidth(3, LANE_WIDTH, 0)).toBe(3 * LANE_WIDTH + PADDING);
	});

	it("keeps one lane's width for a graph with no commits", () => {
		expect(graphTargetWidth(0, LANE_WIDTH, 0)).toBe(LANE_WIDTH + PADDING);
	});

	describe("when the lanes are narrower than the header", () => {
		it("keeps the header readable", () => {
			expect(graphTargetWidth(1, LANE_WIDTH, 500)).toBe(500);
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
