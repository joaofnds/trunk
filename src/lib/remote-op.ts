import { safeInvoke, type TrunkError } from "./invoke.js";
import type { RemoteOpKind, RemoteState } from "./remote-state.svelte.js";
import { showToast } from "./toast.svelte.js";

const OP_KINDS: Record<string, RemoteOpKind> = {
	git_push: "push",
	git_push_force: "push",
	git_pull: "pull",
	git_fetch: "fetch",
};

export async function runRemoteOp(
	remoteState: RemoteState,
	repoPath: string,
	cmd: string,
	successMsg: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	remoteState.isRunning = true;
	remoteState.error = null;
	remoteState.progressLine = "";
	remoteState.lastOp = OP_KINDS[cmd] ?? null;
	try {
		await safeInvoke(cmd, { path: repoPath, ...extra });
		remoteState.isRunning = false;
		remoteState.progressLine = "";
		showToast(successMsg, "success");
	} catch (e: unknown) {
		remoteState.isRunning = false;
		remoteState.error = e as TrunkError;
	}
}
