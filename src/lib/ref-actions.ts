import { ask } from "./dialog.js";
import { forDisplay } from "./display-text.js";
import { reportErrorToast } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

// Each resolves whether a ref changed, so the caller knows to read the refs again.

export async function deleteRemoteBranch(
	repoPath: string,
	branchName: string,
): Promise<boolean> {
	try {
		const confirmed = await ask(
			`Delete remote branch '${forDisplay(branchName)}'? This will remove it from the remote.`,
			{ title: "Delete Remote Branch", kind: "warning" },
		);
		if (!confirmed) return false;

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
	try {
		const confirmed = await ask(
			`Delete tag '${forDisplay(tagName)}'? This cannot be undone.`,
			{ title: "Delete Tag", kind: "warning" },
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
