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
