import { describe, expect, it } from "vitest";
import type { TrunkError } from "./invoke.js";
import { remoteErrorMessage } from "./remote-error.js";

function err(code: string, message = "raw git stderr"): TrunkError {
	return { code, message };
}

describe("remoteErrorMessage", () => {
	it.each([
		[
			"auth_failure",
			"Authentication failed — check your SSH key or credential helper",
		],
		[
			"non_fast_forward",
			"Push rejected — the remote has commits you don’t have locally",
		],
		["no_upstream", "This branch has no upstream on the remote"],
		[
			"push_declined",
			"The remote refused this push — a branch protection rule or a server-side hook rejected it",
		],
		[
			"push_lease_refused",
			"Push rejected — the remote has commits you don’t have locally",
		],
	])("describes %s", (code, expected) => {
		expect(remoteErrorMessage(err(code), "push")).toBe(expected);
	});

	// The raw stderr for this one is git's progress lines plus four hint lines,
	// which is what the user saw before it was classified.
	it("says a stopped rebase in its own words, not git's", () => {
		const message = remoteErrorMessage(
			err(
				"rebase_conflict",
				'Rebasing (1/1) error: could not apply a3d06e5... hint: run "git rebase --continue".',
			),
			"pull",
		);

		expect(message).toBe(
			"Pulled with rebase and stopped on a conflict — resolve the conflicted files, then continue the rebase",
		);
		expect(message).not.toContain("hint:");
	});

	it("passes an unrecognised failure through unchanged", () => {
		expect(remoteErrorMessage(err("remote_error", "ssh: no route"))).toBe(
			"ssh: no route",
		);
	});

	it.each([
		["non_fast_forward", "fetch" as const],
		["non_fast_forward", "pull" as const],
		["non_fast_forward", null],
		["push_lease_refused", "fetch" as const],
	])("does not blame a push for %s reported by %s", (code, lastOp) => {
		expect(remoteErrorMessage(err(code), lastOp)).not.toContain("Push");
	});
});
