import { forDisplay, MAX_PATH_CHARS } from "./display-text.js";
import { isTrunkError, safeInvoke } from "./invoke.js";
import type { BranchHold, RemovalRisk, WorktreeRemoval } from "./types.js";

export type DeletePrompt =
	| {
			kind: "ask";
			message: string;
			okLabel: string;
			cancelLabel: string;
			removal: WorktreeRemoval | null;
	  }
	| { kind: "refuse"; message: string };

const TITLE = "Delete Branch";

/** Codes after which the worktree is not the one the user was asked about. */
const ASK_AGAIN = new Set(["worktree_at_risk", "worktree_changed"]);

/**
 * Asks before deleting `branchName` and deletes it once the user agrees,
 * removing the linked worktree that holds it when they agreed to that too.
 * Resolves false when the user declined or Trunk refused.
 */
export async function deleteBranch(
	repoPath: string,
	branchName: string,
): Promise<boolean> {
	try {
		return await askThenDelete(repoPath, branchName);
	} catch (e) {
		if (!isTrunkError(e) || !ASK_AGAIN.has(e.code)) throw e;
		return await askThenDelete(repoPath, branchName);
	}
}

async function askThenDelete(
	repoPath: string,
	branchName: string,
): Promise<boolean> {
	const { ask, message } = await import("@tauri-apps/plugin-dialog");
	const hold = await safeInvoke<BranchHold>("branch_hold", {
		path: repoPath,
		branchName,
	});
	const prompt = deletePrompt(branchName, hold);

	if (prompt.kind === "refuse") {
		await message(prompt.message, { title: TITLE, kind: "warning" });
		return false;
	}

	const confirmed = await ask(prompt.message, {
		title: TITLE,
		kind: "warning",
		okLabel: prompt.okLabel,
		cancelLabel: prompt.cancelLabel,
	});
	if (!confirmed) return false;

	await safeInvoke("delete_branch", {
		path: repoPath,
		branchName,
		worktree: prompt.removal,
	});
	return true;
}

export function deletePrompt(
	branchName: string,
	hold: BranchHold,
): DeletePrompt {
	const branch = forDisplay(branchName);

	switch (hold.kind) {
		case "not_held":
		case "held_by_main":
			return {
				kind: "ask",
				message: `Delete branch '${branch}'? This cannot be undone.`,
				okLabel: "Yes",
				cancelLabel: "No",
				removal: null,
			};
		case "offer":
			return {
				kind: "ask",
				message: `'${branch}' is checked out in the worktree at ${pathText(hold.path)}.\n\nRemove that worktree and delete the branch? This cannot be undone.`,
				okLabel: "Remove Worktree and Delete",
				cancelLabel: "Cancel",
				removal: { name: hold.name, path: hold.path, go_ahead: false },
			};
		case "warn":
			return {
				kind: "ask",
				message: `'${branch}' is checked out in the worktree at ${pathText(hold.path)}, and removing it may lose work:\n\n${hold.reasons.map((reason) => `- ${riskText(reason)}`).join("\n")}\n\nRemove it anyway and delete the branch? This cannot be undone.`,
				okLabel: "Remove Anyway and Delete",
				cancelLabel: "Cancel",
				removal: { name: hold.name, path: hold.path, go_ahead: true },
			};
		case "refuse":
			return { kind: "refuse", message: refusalText(branch, hold) };
	}
}

function riskText(risk: RemovalRisk): string {
	switch (risk.kind) {
		case "changes":
			return "It has uncommitted or untracked changes.";
		case "unchecked":
			return "Its changes could not be checked.";
		case "locked":
			return risk.reason === null
				? "It is locked."
				: `It is locked: ${forDisplay(risk.reason)}`;
		case "submodules":
			return "It contains submodules, whose commits may exist only there.";
	}
}

function refusalText(
	branch: string,
	hold: Extract<BranchHold, { kind: "refuse" }>,
): string {
	const paths = hold.paths.map(pathText);

	switch (hold.reason) {
		case "mismatched":
			return `Cannot delete '${branch}'. The worktree at ${paths.join(", ")} has it checked out, and its .git file does not point back at this repository, so Trunk will not remove it.`;
		case "several_holders":
			return `Cannot delete '${branch}'. More than one worktree has it checked out:\n\n${paths.map((path) => `- ${path}`).join("\n")}`;
		case "open_in_tab":
			return `Cannot delete '${branch}' while the worktree at ${paths.join(", ")}, which has it checked out, is open in a tab. Close that tab, then delete again.`;
	}
}

function pathText(path: string): string {
	return forDisplay(path, MAX_PATH_CHARS);
}
