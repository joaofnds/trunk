import type { MenuItem } from "@tauri-apps/api/menu";
import { ask } from "./dialog.js";
import { forDisplay } from "./display-text.js";
import { errorMessage, reportErrorToast } from "./error-report.js";
import { isTrunkError, safeInvoke } from "./invoke.js";
import { remoteErrorMessage } from "./remote-error.js";
import { runRemoteOp, whileRemoteRuns } from "./remote-op.js";
import type { RemoteState } from "./remote-state.svelte.js";
import type { TagAction } from "./tag-menu.js";
import { showToast } from "./toast.svelte.js";

// Each resolves whether a ref changed, so the caller knows to read the refs again.

export async function deleteRemoteBranch(
	repoPath: string,
	branchName: string,
	remoteState: RemoteState,
): Promise<boolean> {
	try {
		const confirmed = await ask(
			`Delete remote branch '${forDisplay(branchName)}'? This will remove it from the remote.`,
			{ title: "Delete Remote Branch", kind: "warning", okLabel: "Delete" },
		);
		if (!confirmed) return false;

		await whileRemoteRuns(remoteState, "push", () =>
			safeInvoke("delete_remote_branch", { path: repoPath, branchName }),
		);
	} catch (e) {
		reportErrorToast(e, "Failed to delete remote branch");
		return false;
	}

	showToast(`Deleted remote branch ${branchName}`, "success");
	return true;
}

export async function deleteTag(
	repoPath: string,
	tagName: string,
): Promise<boolean> {
	try {
		const confirmed = await ask(
			`Delete tag '${forDisplay(tagName)}'? This cannot be undone.`,
			{ title: "Delete Tag", kind: "warning", okLabel: "Delete" },
		);
		if (!confirmed) return false;

		await safeInvoke("delete_tag", { path: repoPath, tagName });
	} catch (e) {
		reportErrorToast(e, "Failed to delete tag");
		return false;
	}

	showToast(`Deleted tag ${tagName}`, "success");
	return true;
}

/** The repository's remotes, or none when they cannot be read. */
export async function listRemotes(repoPath: string): Promise<string[]> {
	try {
		return await safeInvoke<string[]>("list_remotes", { path: repoPath });
	} catch {
		return [];
	}
}

/** Runs a tag menu entry. Resolves whether a ref here changed. */
export async function runTagAction(
	repoPath: string,
	tagName: string,
	action: TagAction,
	remoteState: RemoteState,
): Promise<boolean> {
	if (action.kind === "delete") return deleteTag(repoPath, tagName);

	const tag = { path: repoPath, remote: action.remote, tagName };
	if (action.kind === "push") {
		await changeOnRemote(
			remoteState,
			"push_tag",
			tag,
			`Pushed tag ${tagName} to ${action.remote}`,
		);
		return false;
	}

	try {
		const confirmed = await ask(
			`Delete tag '${forDisplay(tagName)}' from ${forDisplay(action.remote)}? This will remove it from the remote.`,
			{ title: "Delete Remote Tag", kind: "warning", okLabel: "Delete" },
		);
		if (!confirmed) return false;
	} catch (e) {
		reportErrorToast(e, "Failed to delete tag");
		return false;
	}
	await changeOnRemote(
		remoteState,
		"delete_remote_tag",
		tag,
		`Deleted tag ${tagName} from ${action.remote}`,
	);
	return false;
}

/**
 * The entries of a local branch's context menu that talk to a remote. The checked-out
 * branch pulls and pushes as the toolbar does, recovery prompt included. Any other
 * branch pushes on its own. While a remote operation runs, they are off.
 */
export async function branchRemoteMenuItems(
	repoPath: string,
	branch: string,
	isHead: boolean,
	remoteState: RemoteState,
): Promise<MenuItem[]> {
	const { MenuItem } = await import("@tauri-apps/api/menu");
	const enabled = !remoteState.isRunning;
	if (!isHead)
		return [
			await MenuItem.new({
				text: `Push ${branch}`,
				enabled,
				action: () => {
					void pushBranch(repoPath, branch, remoteState);
				},
			}),
		];
	return Promise.all([
		MenuItem.new({
			text: "Pull",
			enabled,
			action: () => {
				void runRemoteOp(
					remoteState,
					repoPath,
					"git_pull",
					"Pulled successfully",
				);
			},
		}),
		MenuItem.new({
			text: "Push",
			enabled,
			action: () => {
				void runRemoteOp(
					remoteState,
					repoPath,
					"git_push",
					"Pushed successfully",
				);
			},
		}),
	]);
}

/** Pushes a branch, checked out or not, without the checked-out branch's recovery prompt. */
export async function pushBranch(
	repoPath: string,
	branch: string,
	remoteState: RemoteState,
): Promise<void> {
	await changeOnRemote(
		remoteState,
		"push_branch",
		{ path: repoPath, branch },
		`Pushed ${branch}`,
	);
}

async function changeOnRemote(
	remoteState: RemoteState,
	command: "push_tag" | "delete_remote_tag" | "push_branch",
	args: Record<string, string>,
	done: string,
): Promise<void> {
	try {
		await whileRemoteRuns(remoteState, "push", () => safeInvoke(command, args));
	} catch (e) {
		showToast(
			isTrunkError(e)
				? remoteErrorMessage(e, "push")
				: errorMessage(e, "The remote did not answer"),
			"error",
		);
		return;
	}
	showToast(done, "success");
}

/** Renames branch `from` to `to`, trimmed. Typing nothing new changes nothing. */
export async function renameBranch(
	repoPath: string,
	rename: { from: string; to: string },
): Promise<boolean> {
	const oldName = rename.from;
	const newName = rename.to.trim();
	if (!newName || newName === oldName) return false;

	try {
		await safeInvoke("rename_branch", { path: repoPath, oldName, newName });
	} catch (e) {
		reportErrorToast(e, "Failed to rename branch");
		return false;
	}

	showToast(`Renamed branch to ${newName}`, "success");
	return true;
}
