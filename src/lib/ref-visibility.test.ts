import { describe, expect, it } from "vitest";
import {
	EVERYTHING_VISIBLE,
	isRefHidden,
	isSectionHidden,
	remoteOf,
	toggleRef,
	toggleRemote,
	toggleSection,
} from "./ref-visibility.js";
import type { RefLabel, RefType } from "./types.js";

function label(name: string, ref_type: RefType, is_head = false): RefLabel {
	return {
		name,
		short_name: name.split("/").slice(2).join("/"),
		ref_type,
		is_head,
		color_index: 0,
	};
}

const main = label("refs/heads/main", "LocalBranch");
const head = label("refs/heads/main", "LocalBranch", true);
const topic = label("refs/remotes/origin/topic", "RemoteBranch");
const forkTopic = label("refs/remotes/origin-fork/topic", "RemoteBranch");
const v1 = label("refs/tags/v1.0.0", "Tag");

describe("isRefHidden", () => {
	it("hides nothing by default", () => {
		for (const ref of [main, topic, v1]) {
			expect(isRefHidden(EVERYTHING_VISIBLE, ref)).toBe(false);
		}
	});

	it("hides a ref named individually", () => {
		const hidden = toggleRef(EVERYTHING_VISIBLE, topic);
		expect(isRefHidden(hidden, topic)).toBe(true);
		expect(isRefHidden(hidden, main)).toBe(false);
	});

	it("hides every branch under a hidden remote, and no other remote's", () => {
		const hidden = toggleRemote(EVERYTHING_VISIBLE, "origin");
		expect(isRefHidden(hidden, topic)).toBe(true);
		expect(isRefHidden(hidden, forkTopic)).toBe(false);
	});

	it("hides every ref of a hidden section", () => {
		const hidden = toggleSection(EVERYTHING_VISIBLE, "Tag");
		expect(isRefHidden(hidden, v1)).toBe(true);
		expect(isRefHidden(hidden, main)).toBe(false);
	});

	// Column 0, the WIP row and the head-lane extension all assume the checked-out
	// branch is in the walk, so the UI never offers to hide it.
	it("never hides HEAD's own branch, even under a hidden section", () => {
		const hidden = toggleSection(
			toggleRef(EVERYTHING_VISIBLE, head),
			"LocalBranch",
		);
		expect(isRefHidden(hidden, head)).toBe(false);
	});

	it("toggling twice returns to visible", () => {
		const once = toggleRef(EVERYTHING_VISIBLE, topic);
		const twice = toggleRef(once, topic);
		expect(isRefHidden(twice, topic)).toBe(false);
	});
});

describe("isSectionHidden", () => {
	it("reports a section the user turned off", () => {
		const hidden = toggleSection(EVERYTHING_VISIBLE, "RemoteBranch");
		expect(isSectionHidden(hidden, "RemoteBranch")).toBe(true);
		expect(isSectionHidden(hidden, "Tag")).toBe(false);
	});
});

describe("remoteOf", () => {
	// A remote name may contain slashes, so the branch cannot be split off the right.
	it("takes the first segment after the prefix", () => {
		expect(remoteOf("refs/remotes/origin/topic")).toBe("origin");
		expect(remoteOf("refs/remotes/origin/feature/nested")).toBe("origin");
	});

	it("is null for anything that is not a remote branch", () => {
		expect(remoteOf("refs/heads/main")).toBeNull();
	});
});
