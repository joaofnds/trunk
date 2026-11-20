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
			return [
				"The remote refused this push — a branch protection rule or a server-side hook rejected it",
				...whatTheServerSaid(error.message),
			].join("\n");
		case "rebase_conflict":
			return "Pulled with rebase and stopped on a conflict — resolve the conflicted files, then continue the rebase";
		case "merge_conflict":
			return "Pulled with a merge and stopped on a conflict. Resolve the conflicted files, then commit the merge";
		default:
			return error.message;
	}
}

// The server's reason for a refusal, a required review or a protected branch, is
// on the lines git prefixes with "remote:". The rest is git's own summary of the
// refusal, which the sentence above already says.
const SERVER_LINE = /^\s*remote:\s*(\S.*?)\s*$/;

function whatTheServerSaid(stderr: string): string[] {
	return stderr
		.split("\n")
		.map(lastShown)
		.filter((said) => said !== undefined);
}

// git prefixes each "\r"-ended part of a server line too, and a terminal shows only
// the last, since each overwrites the one before: a hook's progress counter.
function lastShown(line: string): string | undefined {
	return line
		.split("\r")
		.map((part) => SERVER_LINE.exec(part)?.[1])
		.filter((said) => said !== undefined)
		.at(-1);
}
