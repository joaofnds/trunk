import { beforeEach, describe, expect, it } from "vitest";
import type { DeletedBranch } from "./types.js";
import {
	_resetHistory,
	deletionToUndo,
	lastDeletion,
	pendingRedo,
	pushRedo,
	type RedoEntry,
	recordDeletion,
	reofferDeletion,
	takeDeletion,
	takeRedo,
} from "./undo-redo.svelte.js";

function deleted(name: string, headOid: string | null = "head"): DeletedBranch {
	return { deletion: 1, name, tip: `tip-of-${name}`, head_oid: headOid };
}

function redo(name: string, repoPath = "/repo"): RedoEntry {
	return { kind: "commit", undoneOid: name, headOid: "head", repoPath };
}

beforeEach(() => {
	_resetHistory();
});

describe("deletions", () => {
	it("hands back the latest deletion first", () => {
		recordDeletion("/repo", deleted("first"));
		recordDeletion("/repo", deleted("second"));

		expect(takeDeletion("/repo")).toEqual(deleted("second"));
		expect(lastDeletion("/repo")).toEqual(deleted("first"));
	});

	it("keeps each repository's deletions to itself", () => {
		recordDeletion("/a", deleted("topic"));

		expect(lastDeletion("/b")).toBeNull();
		expect(takeDeletion("/b")).toBeNull();
	});

	it("ends what Redo could take again once the user deletes a branch", () => {
		pushRedo(redo("c2"));

		recordDeletion("/repo", deleted("topic"));

		expect(pendingRedo("/repo")).toBeNull();
	});

	it("leaves another repository's redo alone", () => {
		pushRedo(redo("c2", "/other"));

		recordDeletion("/repo", deleted("topic"));

		expect(pendingRedo("/other")).toEqual(redo("c2", "/other"));
	});

	it("keeps the redo when a delete is offered to Undo again", () => {
		pushRedo(redo("c2"));

		reofferDeletion("/repo", deleted("topic"));

		expect(pendingRedo("/repo")).toEqual(redo("c2"));
	});
});

describe("deletionToUndo", () => {
	it("puts back the latest delete while HEAD has not moved since it", () => {
		recordDeletion("/repo", deleted("topic", "head"));

		const chosen = deletionToUndo("/repo", {
			headOid: "head",
			canUndoCommit: true,
		});

		expect(chosen).toEqual(deleted("topic", "head"));
	});

	it("leaves the delete for later once a commit Undo can take back has moved HEAD", () => {
		recordDeletion("/repo", deleted("topic", "before-the-commit"));

		const chosen = deletionToUndo("/repo", {
			headOid: "the-commit",
			canUndoCommit: true,
		});

		expect(chosen).toBeNull();
	});

	it("puts back the delete once what moved HEAD since cannot be undone", () => {
		recordDeletion("/repo", deleted("topic", "before-the-pull"));

		const chosen = deletionToUndo("/repo", {
			headOid: "after-the-pull",
			canUndoCommit: false,
		});

		expect(chosen).toEqual(deleted("topic", "before-the-pull"));
	});

	it("puts back a delete made while HEAD had no commit while it still has none", () => {
		recordDeletion("/repo", deleted("topic", null));

		const chosen = deletionToUndo("/repo", {
			headOid: null,
			canUndoCommit: false,
		});

		expect(chosen).toEqual(deleted("topic", null));
	});

	it("has nothing to put back in a repository with no delete", () => {
		recordDeletion("/a", deleted("topic"));

		const chosen = deletionToUndo("/b", {
			headOid: "head",
			canUndoCommit: false,
		});

		expect(chosen).toBeNull();
	});
});

describe("redo", () => {
	it("hands back the latest step first", () => {
		pushRedo(redo("first"));
		pushRedo(redo("second"));

		expect(takeRedo("/repo")).toEqual(redo("second"));
		expect(pendingRedo("/repo")).toEqual(redo("first"));
	});

	it("has nothing for a repository that never undid anything", () => {
		pushRedo(redo("c2", "/a"));

		expect(pendingRedo("/b")).toBeNull();
		expect(takeRedo("/b")).toBeNull();
	});
});
