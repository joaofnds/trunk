import type { TrunkError } from "./invoke.js";

// Human-readable text for a failed remote operation, shared by the toolbar and the
// push-recovery surface so both describe the same failure the same way.
export function remoteErrorMessage(error: TrunkError): string {
	switch (error.code) {
		case "auth_failure":
			return "Authentication failed — check your SSH key or credential helper";
		case "non_fast_forward":
			return "Push rejected — the remote has commits you don’t have locally";
		case "no_upstream":
			return "This branch has no upstream on the remote";
		default:
			return error.message;
	}
}

// A lease-protected force push (`--force-with-lease --force-if-includes`) that git
// refuses because the local reflog does not contain the current remote tip. Both
// markers are unique to a force push — a plain push rejection says "fetch first" —
// so their presence unambiguously means our force push was refused, not a first-time
// divergence. Such a refusal re-classifies as `non_fast_forward`, so the code alone
// cannot distinguish it; the stderr in `message` can.
export function isForcePushRefusal(error: TrunkError): boolean {
	if (error.code !== "non_fast_forward") return false;
	const m = error.message.toLowerCase();
	return (
		m.includes("remote ref updated since checkout") || m.includes("stale info")
	);
}
