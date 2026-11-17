import { describe, expect, it } from "vitest";
import { makeCommit } from "../__tests__/helpers/factories.js";
import { canFastForward } from "./fast-forward.js";

// Newest first, as the graph lists them:
//   feature-tip ─ feature-base ─┐
//   side ───────────────────────┤ (side branches off below main)
//   main (HEAD) ────────────────┤
//   base ───────────────────────┘
const commits = [
	makeCommit({ oid: "feature-tip", parent_oids: ["feature-base"] }),
	makeCommit({ oid: "feature-base", parent_oids: ["main"] }),
	makeCommit({ oid: "side", parent_oids: ["base"] }),
	makeCommit({ oid: "main", parent_oids: ["base"], is_head: true }),
	makeCommit({ oid: "base", parent_oids: [] }),
];

describe("canFastForward", () => {
	it("allows a commit that descends from HEAD", () => {
		expect(
			canFastForward(commits, { head: "main", target: "feature-tip" }),
		).toBe(true);
	});

	it("refuses a commit on a branch that forked below HEAD", () => {
		expect(canFastForward(commits, { head: "main", target: "side" })).toBe(
			false,
		);
	});

	it("refuses an ancestor of HEAD, which would move nothing", () => {
		expect(canFastForward(commits, { head: "main", target: "base" })).toBe(
			false,
		);
	});

	it("refuses HEAD itself", () => {
		expect(canFastForward(commits, { head: "main", target: "main" })).toBe(
			false,
		);
	});

	it("follows a merge's second parent down to HEAD", () => {
		const merged = [
			makeCommit({ oid: "merge", parent_oids: ["side", "main"] }),
			...commits.slice(2),
		];
		expect(canFastForward(merged, { head: "main", target: "merge" })).toBe(
			true,
		);
	});

	it("refuses when HEAD is not among the loaded rows", () => {
		expect(
			canFastForward(commits.slice(0, 2), {
				head: "main",
				target: "feature-tip",
			}),
		).toBe(false);
	});
});
