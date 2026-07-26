import { isTrunkError, safeInvoke } from "./invoke.js";
import type { RemoteOpKind, RemoteState } from "./remote-state.svelte.js";
import { showToast } from "./toast.svelte.js";

const OP_KINDS = {
	git_push: "push",
	git_push_force: "push",
	git_pull: "pull",
	git_fetch: "fetch",
} as const satisfies Record<string, RemoteOpKind>;

export type RemoteCommand = keyof typeof OP_KINDS;

export async function runRemoteOp(
	remoteState: RemoteState,
	repoPath: string,
	cmd: RemoteCommand,
	successMsg: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	remoteState.isRunning = true;
	remoteState.error = null;
	remoteState.progressLine = "";
	remoteState.lastOp = OP_KINDS[cmd];
	try {
		await safeInvoke(cmd, { path: repoPath, ...extra });
		remoteState.isRunning = false;
		remoteState.progressLine = "";
		showToast(successMsg, "success");
	} catch (e: unknown) {
		remoteState.isRunning = false;
		remoteState.error = isTrunkError(e)
			? e
			: { code: "unknown_error", message: String(e) };
	}
}
