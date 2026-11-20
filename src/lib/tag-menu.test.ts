import { describe, expect, it } from "vitest";
import { tagMenuEntriesOf } from "./tag-menu.js";

function texts(groups: { text: string }[][]): string[][] {
	return groups.map((group) => group.map((entry) => entry.text));
}

describe("tagMenuEntriesOf", () => {
	it("offers a push to each remote, then a delete here and on each remote", () => {
		const groups = tagMenuEntriesOf("v1.0", ["origin", "fork"], false);

		expect(texts(groups)).toEqual([
			["Push v1.0 to origin", "Push v1.0 to fork"],
			[
				"Delete v1.0 locally",
				"Delete v1.0 from origin",
				"Delete v1.0 from fork",
			],
		]);
		expect(groups[1]?.map((entry) => entry.action)).toEqual([
			{ kind: "delete" },
			{ kind: "delete_remote", remote: "origin" },
			{ kind: "delete_remote", remote: "fork" },
		]);
	});

	it("offers only the delete in a repository with no remote", () => {
		expect(texts(tagMenuEntriesOf("v1.0", [], false))).toEqual([
			["Delete v1.0"],
		]);
	});

	it("turns off what talks to a remote while a remote operation runs", () => {
		const enabled = tagMenuEntriesOf("v1.0", ["origin"], true).map((group) =>
			group.map((entry) => [entry.text, entry.enabled]),
		);

		expect(enabled).toEqual([
			[["Push v1.0 to origin", false]],
			[
				["Delete v1.0 locally", true],
				["Delete v1.0 from origin", false],
			],
		]);
	});
});
