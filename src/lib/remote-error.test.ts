import { describe, expect, it } from "vitest";
import type { TrunkError } from "./invoke.js";
import { isForcePushRefusal, remoteErrorMessage } from "./remote-error.js";

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
	])("describes %s", (code, expected) => {
		expect(remoteErrorMessage(err(code))).toBe(expected);
	});

	it("passes an unrecognised failure through unchanged", () => {
		expect(remoteErrorMessage(err("remote_error", "ssh: no route"))).toBe(
			"ssh: no route",
		);
	});
});

describe("isForcePushRefusal", () => {
	it.each([
		["! [rejected] main -> main (remote ref updated since checkout)"],
		["! [rejected] main -> main (stale info)"],
	])("recognises %s", (stderr) => {
		expect(isForcePushRefusal(err("non_fast_forward", stderr))).toBe(true);
	});

	it("is false for a plain divergence", () => {
		expect(
			isForcePushRefusal(
				err("non_fast_forward", "! [rejected] main -> main (fetch first)"),
			),
		).toBe(false);
	});

	it("ignores a marker the remote wrote on its own lines", () => {
		const stderr = [
			"remote: error: your push contains stale info, please retry",
			"remote: error: remote ref updated since checkout",
			" ! [rejected]        main -> main (fetch first)",
			"error: failed to push some refs to 'origin'",
		].join("\n");

		expect(isForcePushRefusal(err("non_fast_forward", stderr))).toBe(false);
	});

	it("is false for a failure that is not a divergence", () => {
		expect(
			isForcePushRefusal(err("auth_failure", "stale info in the message")),
		).toBe(false);
	});
});
