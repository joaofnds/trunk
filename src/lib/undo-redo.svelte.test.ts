import { beforeEach, describe, expect, it } from "vitest";
import type { DeletedBranch } from "./types.js";
import {
	_resetHistory,
	lastDeletion,
	pendingRedo,
	pushDeletion,
	pushRedo,
	type RedoEntry,
	recordDeletion,
	takeDeletion,
	takeRedo,
} from "./undo-redo.svelte.js";

function deleted(name: string): DeletedBranch {
	return { name, tip: `tip-of-${name}`, config: [], head_oid: "head" };
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
		expect(takeDeletion("/b")).toBeUndefined();
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

	it("keeps the redo when a redone delete is handed back", () => {
		pushRedo(redo("c2"));

		pushDeletion("/repo", deleted("topic"));

		expect(pendingRedo("/repo")).toEqual(redo("c2"));
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
		expect(takeRedo("/b")).toBeUndefined();
	});
});
