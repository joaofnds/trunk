import { ask } from "./dialog.js";
import { reportErrorToast } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

// The graph and the sidebar both offer these, so each action reports its own
// outcome and the two report it alike. Each resolves whether a ref changed, so
// the caller knows whether to read the refs again.

export async function deleteRemoteBranch(
	repoPath: string,
	branchName: string,
): Promise<boolean> {
	const confirmed = await ask(
		`Delete remote branch '${branchName}'? This will remove it from the remote.`,
		{ title: "Delete Remote Branch", kind: "warning" },
	);
	if (!confirmed) return false;
	try {
		await safeInvoke("delete_remote_branch", { path: repoPath, branchName });
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
	const confirmed = await ask(
		`Delete tag '${tagName}'? This cannot be undone.`,
		{ title: "Delete Tag", kind: "warning" },
	);
	if (!confirmed) return false;
	try {
		await safeInvoke("delete_tag", { path: repoPath, tagName });
	} catch (e) {
		reportErrorToast(e, "Failed to delete tag");
		return false;
	}
	showToast(`Deleted tag ${tagName}`, "success");
	return true;
}

/** Renames `oldName` to what the user typed, trimmed. Typing nothing new changes nothing. */
export async function renameBranch(
	repoPath: string,
	oldName: string,
	typed: string,
): Promise<boolean> {
	const newName = typed.trim();
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
