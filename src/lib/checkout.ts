import { reportErrorToast } from "./error-report.js";
import { isTrunkError } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

export const CHECKOUT_CONFLICT_MESSAGE =
	"Your uncommitted changes conflict with this branch. Commit them, or stage and stash them, first.";

export function checkedOutMessage(branch: string): string {
	return `Checked out ${branch}`;
}

/** A branch checkout or creation refused because it would overwrite uncommitted changes. */
export function isCheckoutConflict(e: unknown): boolean {
	return isTrunkError(e) && e.code === "dirty_workdir";
}

/** Tells the user why a checkout failed, in the words a dirty working tree gets everywhere. */
export function reportCheckoutFailure(e: unknown): void {
	if (isCheckoutConflict(e)) showToast(CHECKOUT_CONFLICT_MESSAGE, "error");
	else reportErrorToast(e, "Checkout failed");
}
