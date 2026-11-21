import { describe, expect, it } from "vitest";
import { afterRev, beforeRev } from "./rev-spec.js";

describe("rev derivation", () => {
	it("maps each diff kind to its after-side rev", () => {
		expect(afterRev("unstaged", "abc")).toEqual({ type: "workingTree" });
		expect(afterRev("staged", "abc")).toEqual({ type: "index" });
		expect(afterRev("commit", "abc")).toEqual({ type: "commit", oid: "abc" });
	});

	it("maps the before side per kind: index for unstaged, HEAD for staged, parent for commit", () => {
		expect(beforeRev("unstaged", null)).toEqual({ type: "index" });
		expect(beforeRev("staged", null)).toEqual({ type: "head" });
		expect(beforeRev("commit", "parent1")).toEqual({
			type: "commit",
			oid: "parent1",
		});
	});

	it("maps a parentless (root) commit's before side to the empty rev", () => {
		expect(beforeRev("commit", null)).toEqual({ type: "empty" });
	});

	it("resolves a compare selection's before side to the compare base, not the target's parent", () => {
		expect(beforeRev("commit", "targetParent", "compareBase")).toEqual({
			type: "commit",
			oid: "compareBase",
		});
	});

	it("reads a current-file view's after side from the working tree", () => {
		expect(afterRev("current_file", "abc")).toEqual({ type: "workingTree" });
	});

	it("gives a current-file view the same working tree on both sides", () => {
		expect(beforeRev("current_file", "parent1")).toEqual({
			type: "workingTree",
		});
	});
});
