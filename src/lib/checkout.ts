import { isTrunkError } from "./invoke.js";

export const CHECKOUT_CONFLICT_MESSAGE =
	"Your uncommitted changes conflict with this branch. Commit or stash them first.";

export function checkedOutMessage(branch: string): string {
	return `Checked out ${branch}`;
}

/** A branch checkout or creation refused because it would overwrite uncommitted changes. */
export function isCheckoutConflict(e: unknown): boolean {
	return isTrunkError(e) && e.code === "dirty_workdir";
}
