import type { TrunkError } from "./invoke.js";
import type { RemoteOpKind } from "./remote-state.svelte.js";

export function remoteErrorMessage(
	error: TrunkError,
	lastOp: RemoteOpKind | null = null,
): string {
	switch (error.code) {
		case "auth_failure":
			return "Authentication failed — check your SSH key or credential helper";
		case "non_fast_forward":
			return lastOp === "push"
				? "Push rejected — the remote has commits you don’t have locally"
				: "The remote has commits you don’t have locally";
		case "no_upstream":
			return "This branch has no upstream on the remote";
		case "push_declined":
			return "The remote refused this push — a branch protection rule or a server-side hook rejected it";
		default:
			return error.message;
	}
}

// Both markers are unique to a lease-refused force push, but only on git's own lines:
// without dropping the `remote:` ones, a hook that prints either phrase makes every
// ordinary divergence render as a refusal.
export function isForcePushRefusal(error: TrunkError): boolean {
	if (error.code !== "non_fast_forward") return false;
	return error.message
		.toLowerCase()
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("remote:"))
		.some(
			(line) =>
				line.includes("remote ref updated since checkout") ||
				line.includes("stale info"),
		);
}
