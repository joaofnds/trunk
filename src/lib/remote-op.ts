import type { FetchReport } from "./autofetch-status.js";
import { isTrunkError, safeInvoke, type TrunkError } from "./invoke.js";
import type { RemoteOpKind, RemoteState } from "./remote-state.svelte.js";
import { showToast } from "./toast.svelte.js";

const OP_KINDS = {
	git_push: "push",
	git_push_force: "push",
	git_push_publish: "push",
	git_pull: "pull",
	git_fetch: "fetch",
} as const satisfies Record<string, RemoteOpKind>;

export type RemoteCommand = keyof typeof OP_KINDS;

const ALREADY_RUNNING: TrunkError = {
	code: "op_in_progress",
	message: "A remote operation is already running",
};

/**
 * Runs `talk` as the tab's one remote operation of `kind`: the toolbar shows it
 * running and holds back another until it ends. While one already runs, refuses
 * without calling `talk`, as the backend would, so the mark stays on the one running.
 * The recovery prompt stays as it stands, since only `runRemoteOp` reports there.
 */
export async function whileRemoteRuns<T>(
	remoteState: RemoteState,
	kind: RemoteOpKind,
	talk: () => Promise<T>,
): Promise<T> {
	if (remoteState.isRunning) throw ALREADY_RUNNING;
	remoteState.isRunning = true;
	remoteState.lastOp = kind;
	try {
		return await talk();
	} finally {
		remoteState.isRunning = false;
	}
}

export async function runRemoteOp(
	remoteState: RemoteState,
	repoPath: string,
	cmd: RemoteCommand,
	successMsg: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const args = { path: repoPath, ...extra };
	try {
		await whileRemoteRuns(remoteState, OP_KINDS[cmd], async () => {
			remoteState.error = null;
			if (cmd === "git_fetch" || cmd === "git_pull") {
				const report = await safeInvoke<FetchReport>(cmd, args);
				remoteState.autofetch = report;
				if (cmd === "git_fetch") remoteState.fetchCompleted();
			} else await safeInvoke<void>(cmd, args);
		});
		showToast(successMsg, "success");
	} catch (e: unknown) {
		remoteState.failedOp = OP_KINDS[cmd];
		remoteState.error = isTrunkError(e)
			? e
			: { code: "unknown_error", message: String(e) };
	}
}
