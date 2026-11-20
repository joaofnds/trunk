import type { MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { ask } from "./dialog.js";
import { forDisplay } from "./display-text.js";
import { errorMessage, reportErrorToast } from "./error-report.js";
import { isTrunkError, safeInvoke } from "./invoke.js";
import { remoteErrorMessage } from "./remote-error.js";
import {
	pullCheckedOut,
	pushCheckedOut,
	refusedWhileRunning,
	whileRemoteRuns,
} from "./remote-op.js";
import type { RemoteState } from "./remote-state.svelte.js";
import type { TagAction } from "./tag-menu.js";
import { showToast } from "./toast.svelte.js";

// Each resolves whether a ref changed, so the caller knows to read the refs again.

export async function deleteRemoteBranch(
	repoPath: string,
	branchName: string,
	remoteState: RemoteState,
): Promise<boolean> {
	if (refusedWhileRunning(remoteState)) return false;
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

/** The repository's remotes. When they cannot be read, says so and answers none. */
export async function listRemotes(repoPath: string): Promise<string[]> {
	try {
		return await safeInvoke<string[]>("list_remotes", { path: repoPath });
	} catch (e) {
		showToast(
			`Could not read the remotes, so the menu leaves them out. ${errorMessage(e, "The repository did not answer")}`,
			"error",
		);
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
		report(
			await onRemote(remoteState, "push_tag", tag),
			`Pushed tag ${tagName} to ${action.remote}`,
		);
		return false;
	}

	if (refusedWhileRunning(remoteState)) return false;
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
	report(
		await onRemote(remoteState, "delete_remote_tag", tag),
		`Deleted tag ${tagName} from ${action.remote}`,
	);
	return false;
}

/**
 * The group of a local branch's context menu that talks to a remote, closed by a
 * separator, or nothing in a repository without remotes. The checked-out branch
 * pulls and pushes as the toolbar does, recovery prompt included. Any other branch
 * pushes on its own. While a remote operation runs, they are off.
 */
export async function branchRemoteMenuGroup(
	repoPath: string,
	branch: string,
	isHead: boolean,
	remoteState: RemoteState,
): Promise<(MenuItem | PredefinedMenuItem)[]> {
	if ((await listRemotes(repoPath)).length === 0) return [];
	const { PredefinedMenuItem } = await import("@tauri-apps/api/menu");
	return [
		...(await branchRemoteMenuItems(repoPath, branch, isHead, remoteState)),
		await PredefinedMenuItem.new({ item: "Separator" }),
	];
}

async function branchRemoteMenuItems(
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
				void pullCheckedOut(remoteState, repoPath);
			},
		}),
		MenuItem.new({
			text: "Push",
			enabled,
			action: () => {
				void pushCheckedOut(remoteState, repoPath);
			},
		}),
	]);
}

/**
 * Pushes a branch, checked out or not, without the checked-out branch's recovery
 * prompt. One that tracks nothing is published only once the user agrees.
 */
export async function pushBranch(
	repoPath: string,
	branch: string,
	remoteState: RemoteState,
): Promise<void> {
	const push = (publish: boolean) =>
		onRemote(remoteState, "push_branch", { path: repoPath, branch, publish });
	let outcome = await push(false);
	if (
		!outcome.ok &&
		isTrunkError(outcome.error) &&
		outcome.error.code === "no_upstream"
	) {
		if (!(await agreesToPublish(outcome.error.message))) return;
		outcome = await push(true);
	}
	report(outcome, `Pushed ${branch}`);
}

async function agreesToPublish(untracked: string): Promise<boolean> {
	try {
		return await ask(`${forDisplay(untracked)} Push it there and track it?`, {
			title: "Push Branch",
			kind: "info",
			okLabel: "Push and Track",
		});
	} catch (e) {
		reportErrorToast(e, "Failed to push branch");
		return false;
	}
}

type TagOnRemote = {
	readonly path: string;
	readonly remote: string;
	readonly tagName: string;
};

/** The arguments of each change a menu makes on a remote. */
type RemoteChanges = {
	push_tag: TagOnRemote;
	delete_remote_tag: TagOnRemote;
	push_branch: {
		readonly path: string;
		readonly branch: string;
		readonly publish: boolean;
	};
};

type Outcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: unknown };

/** Runs `command` as the tab's push, leaving the recovery prompt as it stands. */
async function onRemote<C extends keyof RemoteChanges>(
	remoteState: RemoteState,
	command: C,
	args: RemoteChanges[C],
): Promise<Outcome> {
	try {
		await whileRemoteRuns(remoteState, "push", () => safeInvoke(command, args));
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	}
}

function report(outcome: Outcome, done: string): void {
	if (outcome.ok) {
		showToast(done, "success");
		return;
	}
	showToast(
		isTrunkError(outcome.error)
			? remoteErrorMessage(outcome.error, "push")
			: errorMessage(outcome.error, "The remote did not answer"),
		"error",
	);
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
