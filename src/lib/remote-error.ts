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
		case "push_lease_refused":
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
