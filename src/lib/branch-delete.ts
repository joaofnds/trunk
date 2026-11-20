import { ask } from "./dialog.js";
import {
	forDisplay,
	MAX_MESSAGE_CHARS,
	MAX_PATH_CHARS,
} from "./display-text.js";
import { isTrunkError, safeInvoke, type TrunkError } from "./invoke.js";
import type { BranchHold, RemovalRisk, WorktreeRemoval } from "./types.js";

export type DeletePrompt =
	| { readonly kind: "ask"; readonly message: string }
	| {
			readonly kind: "remove";
			readonly message: string;
			readonly okLabel: string;
			readonly removal: WorktreeRemoval;
	  }
	| { readonly kind: "refuse"; readonly message: string };

export type DeleteOutcome =
	| { readonly kind: "declined" }
	| { readonly kind: "deleted"; readonly report: string };

const TITLE = "Delete Branch";

/** Codes after which the user's answer no longer fits the worktree: another one holds
 *  the branch, or it now holds work the question did not warn about. */
const ASK_AGAIN = new Set(["worktree_at_risk", "worktree_changed"]);

/**
 * Asks before deleting `branchName` and deletes it once the user agrees,
 * removing the linked worktree that holds it when they agreed to that too.
 * Rejects with the reason when Trunk refuses or the delete fails.
 */
export async function deleteBranch(
	repoPath: string,
	branchName: string,
): Promise<DeleteOutcome> {
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
): Promise<DeleteOutcome> {
	const [hold, lost] = await Promise.all([
		safeInvoke<BranchHold>("branch_hold", { path: repoPath, branchName }),
		safeInvoke<number>("commits_only_on_branch", {
			path: repoPath,
			branchName,
		}).catch(() => null),
	]);
	const prompt = deletePrompt(branchName, hold, lost);

	if (prompt.kind === "refuse") {
		const refusal: TrunkError = {
			code: "delete_refused",
			message: prompt.message,
		};
		throw refusal;
	}

	const confirmed = await ask(prompt.message, {
		title: TITLE,
		kind: "warning",
		okLabel: prompt.kind === "remove" ? prompt.okLabel : "Delete",
	});
	if (!confirmed) return { kind: "declined" };

	let tip: string;
	try {
		tip = await safeInvoke<string>("delete_branch", {
			path: repoPath,
			branchName,
			worktree: prompt.kind === "remove" ? prompt.removal : null,
		});
	} catch (e) {
		// The message names worktree paths and the files left behind, which the
		// repository chose, so it is flattened like the question was.
		if (!isTrunkError(e)) throw e;
		throw { ...e, message: forDisplay(e.message, MAX_MESSAGE_CHARS) };
	}
	return {
		kind: "deleted",
		report: `Deleted branch ${forDisplay(branchName, MAX_PATH_CHARS)} (was ${tip.slice(0, 7)})`,
	};
}

/** `lost` counts the commits no other branch, tag or HEAD contains, which the
 *  delete would leave behind, or is null when they could not be counted. The count
 *  only informs the question, so the question is asked without it. */
export function deletePrompt(
	branchName: string,
	hold: BranchHold,
	lost: number | null,
): DeletePrompt {
	const branch = forDisplay(branchName, MAX_PATH_CHARS);
	const withLost = lost === null ? "" : lostText(lost);
	const unchecked =
		lost === null
			? " Trunk could not check whether another branch or tag contains its commits."
			: "";

	switch (hold.kind) {
		case "not_held":
		case "held_by_main":
			return {
				kind: "ask",
				message: `Delete branch '${branch}'${withLost}?${unchecked}`,
			};
		case "offer":
			return {
				kind: "remove",
				message: `'${branch}' is checked out in the worktree at ${pathText(hold.path)}.\n\nRemove that worktree and delete the branch${withLost}? This cannot be undone.${unchecked}`,
				okLabel: "Remove Worktree and Delete",
				removal: { name: hold.name, path: hold.path, go_ahead: false },
			};
		case "warn": {
			const reasons = hold.reasons
				.map((reason) => `- ${riskText(reason)}`)
				.join("\n");
			return {
				kind: "remove",
				message: `'${branch}' is checked out in the worktree at ${pathText(hold.path)}, and removing it may lose work:\n\n${reasons}\n\nRemove it anyway and delete the branch${withLost}? This cannot be undone.${unchecked}`,
				okLabel: "Remove Anyway and Delete",
				removal: { name: hold.name, path: hold.path, go_ahead: true },
			};
		}
		case "refuse":
			return { kind: "refuse", message: refusalText(branch, hold) };
	}
}

function lostText(lost: number): string {
	if (lost === 0) return "";

	const commits = lost === 1 ? "1 commit" : `${lost} commits`;
	return ` with the ${commits} no other branch or tag contains`;
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
			return `Cannot delete '${branch}'. More than one worktree uses it:\n\n${paths.map((path) => `- ${path}`).join("\n")}`;
		case "open_in_tab":
			return `Cannot delete '${branch}' while the worktree at ${paths.join(", ")}, which has it checked out, is open in a tab. Close that tab, then delete again.`;
		case "rebasing":
			return `Cannot delete '${branch}' while the worktree at ${paths.join(", ")} is rebasing it. Finish or abort the rebase there, then delete again.`;
		case "missing":
			return `Cannot delete '${branch}'. Git still counts it as used by the worktree at ${paths.join(", ")}, whose directory is missing.`;
	}
}

function pathText(path: string): string {
	return forDisplay(path, MAX_PATH_CHARS);
}
