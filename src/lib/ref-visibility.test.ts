import { describe, expect, it } from "vitest";
import {
	EVERYTHING_VISIBLE,
	type GroupState,
	groupState,
	hidesNothing,
	isRefHidden,
	isStashHidden,
	remoteOf,
	setGroupHidden,
	toggleRef,
	toggleStash,
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
const other = label("refs/heads/other", "LocalBranch");
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

	// Column 0, the WIP row and the head-lane extension all assume the checked-out
	// branch is in the walk, so the UI never offers to hide it.
	it("never hides HEAD's own branch", () => {
		const hidden = toggleRef(EVERYTHING_VISIBLE, head);
		expect(isRefHidden(hidden, head)).toBe(false);
	});

	it("toggling twice returns to visible", () => {
		const once = toggleRef(EVERYTHING_VISIBLE, topic);
		const twice = toggleRef(once, topic);
		expect(isRefHidden(twice, topic)).toBe(false);
	});
});

// A group toggle is a bulk action over the rows it covers, never a flag of its own. Every
// row's own entry is the whole state, so nothing can be hidden by a rule the row does not
// show, and the group icon always agrees with the rows under it.
describe("setGroupHidden", () => {
	it("hides every member of the group", () => {
		const hidden = setGroupHidden(EVERYTHING_VISIBLE, [topic, forkTopic], true);

		expect(isRefHidden(hidden, topic)).toBe(true);
		expect(isRefHidden(hidden, forkTopic)).toBe(true);
	});

	it("leaves a ref outside the group alone", () => {
		const hidden = setGroupHidden(EVERYTHING_VISIBLE, [topic], true);
		expect(isRefHidden(hidden, forkTopic)).toBe(false);
	});

	it("shows every member again", () => {
		const hidden = setGroupHidden(EVERYTHING_VISIBLE, [topic, forkTopic], true);
		const shown = setGroupHidden(hidden, [topic, forkTopic], false);

		expect(hidesNothing(shown)).toBe(true);
	});

	// The defect this replaced: a section flag left a row's own state invisible and
	// unreachable, so showing the section resurrected rows the user had hidden.
	it("showing a group leaves nothing hidden behind it", () => {
		const oneHidden = toggleRef(EVERYTHING_VISIBLE, topic);
		const allHidden = setGroupHidden(oneHidden, [topic, forkTopic], true);
		const shown = setGroupHidden(allHidden, [topic, forkTopic], false);

		expect(isRefHidden(shown, topic)).toBe(false);
		expect(isRefHidden(shown, forkTopic)).toBe(false);
	});

	it("hiding a group twice is the same as hiding it once", () => {
		const once = setGroupHidden(EVERYTHING_VISIBLE, [topic], true);
		const twice = setGroupHidden(once, [topic], true);
		expect(twice.hiddenRefs).toEqual(once.hiddenRefs);
	});

	// HEAD's branch is not hideable, so a group containing it hides everything else and
	// counts as fully hidden — otherwise its toggle could never reach the "hidden" state.
	it("skips HEAD's own branch when hiding its section", () => {
		const hidden = setGroupHidden(EVERYTHING_VISIBLE, [head, other], true);

		expect(isRefHidden(hidden, head)).toBe(false);
		expect(isRefHidden(hidden, other)).toBe(true);
		expect(groupState(hidden, [head, other])).toBe<GroupState>("all");
	});
});

// The group icon reports what the rows under it actually are, so it can never contradict
// them.
describe("groupState", () => {
	it("is none when every member is visible", () => {
		expect(groupState(EVERYTHING_VISIBLE, [topic, forkTopic])).toBe<GroupState>(
			"none",
		);
	});

	it("is all when every member is hidden", () => {
		const hidden = setGroupHidden(EVERYTHING_VISIBLE, [topic, forkTopic], true);
		expect(groupState(hidden, [topic, forkTopic])).toBe<GroupState>("all");
	});

	it("is some when the group is mixed", () => {
		const hidden = toggleRef(EVERYTHING_VISIBLE, topic);
		expect(groupState(hidden, [topic, forkTopic])).toBe<GroupState>("some");
	});

	// An empty group has nothing hidden, so its toggle offers to hide.
	it("is none for an empty group", () => {
		expect(groupState(EVERYTHING_VISIBLE, [])).toBe<GroupState>("none");
	});

	// A group of nothing but HEAD's branch can never be hidden, so it reports none and its
	// toggle stays an offer to hide rather than a lie about the state.
	it("is none for a group holding only HEAD's branch", () => {
		expect(groupState(EVERYTHING_VISIBLE, [head])).toBe<GroupState>("none");
	});
});

describe("stashes", () => {
	it("hides a stash by its commit oid", () => {
		const hidden = toggleStash(EVERYTHING_VISIBLE, "abc123");
		expect(isStashHidden(hidden, "abc123")).toBe(true);
		expect(isStashHidden(hidden, "def456")).toBe(false);
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

describe("hidesNothing", () => {
	it("is true for the empty value", () => {
		expect(hidesNothing(EVERYTHING_VISIBLE)).toBe(true);
	});

	it("is false once any ref is hidden", () => {
		expect(hidesNothing(toggleRef(EVERYTHING_VISIBLE, topic))).toBe(false);
		expect(hidesNothing(toggleStash(EVERYTHING_VISIBLE, "abc"))).toBe(false);
	});

	// A value read back from prefs is a different object with the same fields, so this
	// has to compare fields rather than identity.
	it("is true for a distinct object that hides nothing", () => {
		expect(hidesNothing({ ...EVERYTHING_VISIBLE })).toBe(true);
	});
});
