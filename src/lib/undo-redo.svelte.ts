import { SvelteMap } from "svelte/reactivity";
import type { DeletedBranch } from "./types.js";

/**
 * A step Redo can take again. `headOid` is where HEAD was once Undo finished,
 * and the step is offered only while HEAD is still there, since anything made
 * since would be rewritten. `repoPath` names the repository, because a tab can
 * be pointed at another one without remounting and two clones share every oid.
 */
export type RedoEntry =
	| {
			kind: "commit";
			/** The commit the undo took back. Redo moves the branch back to this
			 *  exact commit, so its oid, date and tree return as they were. */
			undoneOid: string;
			headOid: string;
			repoPath: string;
	  }
	| {
			kind: "delete";
			/** The branch the undo put back, which Redo deletes again. */
			deleted: DeletedBranch;
			headOid: string;
			repoPath: string;
	  };

// History belongs to the repository rather than the tab, so every tab on it and
// every place a branch is deleted from share one.
const deletions = new SvelteMap<string, DeletedBranch[]>();
const redos = new SvelteMap<string, RedoEntry[]>();

/** Remembers a branch the user deleted, so Undo can put it back. A new action
 *  ends what Redo could take again. */
export function recordDeletion(repoPath: string, deleted: DeletedBranch): void {
	pushDeletion(repoPath, deleted);
	redos.delete(repoPath);
}

/** Puts a deletion back where Undo finds it, as a redo of the delete does. */
export function pushDeletion(repoPath: string, deleted: DeletedBranch): void {
	deletions.set(repoPath, [...(deletions.get(repoPath) ?? []), deleted]);
}

export function lastDeletion(repoPath: string): DeletedBranch | null {
	return deletions.get(repoPath)?.at(-1) ?? null;
}

export function takeDeletion(repoPath: string): DeletedBranch | undefined {
	const stack = deletions.get(repoPath) ?? [];
	deletions.set(repoPath, stack.slice(0, -1));
	return stack.at(-1);
}

export function pushRedo(entry: RedoEntry): void {
	redos.set(entry.repoPath, [...(redos.get(entry.repoPath) ?? []), entry]);
}

export function pendingRedo(repoPath: string): RedoEntry | null {
	return redos.get(repoPath)?.at(-1) ?? null;
}

export function takeRedo(repoPath: string): RedoEntry | undefined {
	const stack = redos.get(repoPath) ?? [];
	redos.set(repoPath, stack.slice(0, -1));
	return stack.at(-1);
}

/** Forget every repository's history. For tests only. */
export function _resetHistory(): void {
	deletions.clear();
	redos.clear();
}
