import { SvelteSet } from "svelte/reactivity";
import { ask } from "./dialog.js";
import { forDisplay } from "./display-text.js";
import { reportErrorToast } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

// Each resolves whether the stash list changed, so the caller knows to read the refs again.

// The toolbar, the commit form and the sidebar all stash, and a second stash
// started while one is being made finds nothing left and reports a failure.
const stashingIn = new SvelteSet<string>();

export function isStashing(repoPath: string): boolean {
	return stashingIn.has(repoPath);
}

export async function saveStash(
	repoPath: string,
	message: string,
): Promise<boolean> {
	if (stashingIn.has(repoPath)) return false;

	stashingIn.add(repoPath);
	try {
		await safeInvoke("stash_save", { path: repoPath, message });
	} catch (e) {
		reportErrorToast(e, "Failed to create stash");
		return false;
	} finally {
		stashingIn.delete(repoPath);
	}

	showToast("Stash created", "success");
	return true;
}

export async function popStash(
	repoPath: string,
	oid: string,
): Promise<boolean> {
	try {
		await safeInvoke("stash_pop", { path: repoPath, oid });
	} catch (e) {
		reportErrorToast(e, "Failed to pop stash");
		return false;
	}

	showToast("Stash popped", "success");
	return true;
}

export async function applyStash(
	repoPath: string,
	oid: string,
): Promise<boolean> {
	try {
		await safeInvoke("stash_apply", { path: repoPath, oid });
	} catch (e) {
		reportErrorToast(e, "Failed to apply stash");
		return false;
	}

	showToast("Stash applied", "success");
	return true;
}

export async function dropStash(
	repoPath: string,
	stash: { oid: string; message: string },
): Promise<boolean> {
	try {
		const confirmed = await ask(
			`Drop stash "${forDisplay(stash.message)}"? This cannot be undone.`,
			{ title: "Drop Stash", kind: "warning", okLabel: "Drop" },
		);
		if (!confirmed) return false;

		await safeInvoke("stash_drop", { path: repoPath, oid: stash.oid });
	} catch (e) {
		reportErrorToast(e, "Failed to drop stash");
		return false;
	}

	showToast("Stash dropped", "success");
	return true;
}
