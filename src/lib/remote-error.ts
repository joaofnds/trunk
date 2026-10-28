import type { TrunkError } from "./invoke.js";
import type { RemoteOpKind } from "./remote-state.svelte.js";

export function remoteErrorMessage(
	error: TrunkError,
	lastOp: RemoteOpKind | null = null,
): string {
	const message = describeFailure(error, lastOp);
	if (error.pull_safety_copy === undefined) return message;

	const ended = message.trimEnd();
	const sentence = /[.!?]$/.test(ended) ? ended : `${ended}.`;
	return `${sentence} Trunk also kept a copy of your changes from before the pull in the stash, named “${error.pull_safety_copy}”.`;
}

function describeFailure(
	error: TrunkError,
	lastOp: RemoteOpKind | null,
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
		case "rebase_conflict":
			return "Pulled with rebase and stopped on a conflict — resolve the conflicted files, then continue the rebase";
		default:
			return error.message;
	}
}
