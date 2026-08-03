import { describe, expect, it } from "vitest";
import { makeCommit } from "../__tests__/helpers/factories";
import { withWipRow } from "./wip-row.js";

const HEAD = makeCommit({
	oid: "a".repeat(40),
	summary: "head commit",
	column: 2,
	color_index: 5,
	in_head_chain: true,
});
const OTHER = makeCommit({
	oid: "b".repeat(40),
	summary: "someone else's branch",
	column: 7,
	color_index: 1,
});

describe("withWipRow", () => {
	it("prepends a row for the uncommitted changes", () => {
		const rows = withWipRow([HEAD], 3, "// WIP");

		expect(rows.map((c) => c.oid)).toEqual(["__wip__", HEAD.oid]);
	});

	it("carries the message it is given", () => {
		const [wip] = withWipRow([HEAD], 1, "staged and unstaged");

		expect(wip.summary).toBe("staged and unstaged");
	});

	// The rule: the WIP row sits at the head-chain column, so its dashed rail
	// continues the branch the user is committing to.
	it("takes its column and colour from the head chain", () => {
		const [wip] = withWipRow([OTHER, HEAD], 1, "// WIP");

		expect(wip.column).toBe(2);
		expect(wip.color_index).toBe(5);
	});

	it("draws a straight edge in its own lane", () => {
		const [wip] = withWipRow([HEAD], 1, "// WIP");

		expect(wip.edges).toEqual([
			{
				from_column: 2,
				to_column: 2,
				edge_type: "Straight",
				color_index: 5,
				dashed: false,
			},
		]);
	});

	describe("when the worktree is clean", () => {
		it("returns the commits alone", () => {
			expect(withWipRow([HEAD], 0, "// WIP")).toEqual([HEAD]);
		});
	});

	describe("when HEAD is detached", () => {
		// Mid-rebase and after checking out a sha there is no is_head row, but the
		// chain is still there — anchoring on is_head would put the WIP row in
		// lane 0, away from the commits it is about.
		const DETACHED = makeCommit({
			oid: "c".repeat(40),
			column: 4,
			color_index: 6,
			is_head: false,
			in_head_chain: true,
		});

		it("still anchors on the head chain", () => {
			const [wip] = withWipRow([DETACHED], 1, "// WIP");

			expect(wip.column).toBe(4);
			expect(wip.color_index).toBe(6);
		});
	});

	describe("when no loaded commit is in the head chain", () => {
		it("falls back to the first lane", () => {
			const [wip] = withWipRow([OTHER], 1, "// WIP");

			expect(wip.column).toBe(0);
			expect(wip.color_index).toBe(0);
		});
	});
});
