import { SvelteMap } from "svelte/reactivity";
import type { DeletedBranch } from "./types.js";

/**
 * A step Redo can take again. `headOid` is where HEAD was once Undo finished, or
 * null while HEAD had no commit, and the step is offered only while HEAD is still
 * there, since anything made since would be rewritten. `repoPath` names the
 * repository, because a tab can be pointed at another one without remounting and
 * two clones share every oid.
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
			headOid: string | null;
			repoPath: string;
	  };

/** The latest first, kept for each repository on its own. */
function historyPerRepository<T>() {
	const stacks = new SvelteMap<string, readonly T[]>();

	return {
		push(repoPath: string, item: T): void {
			stacks.set(repoPath, [...(stacks.get(repoPath) ?? []), item]);
		},
		latest(repoPath: string): T | null {
			return stacks.get(repoPath)?.at(-1) ?? null;
		},
		take(repoPath: string): T | null {
			const stack = stacks.get(repoPath) ?? [];
			stacks.set(repoPath, stack.slice(0, -1));
			return stack.at(-1) ?? null;
		},
		forget(repoPath: string): void {
			stacks.delete(repoPath);
		},
		clear(): void {
			stacks.clear();
		},
	};
}

// History belongs to the repository rather than the tab, so every tab on it and
// every place a branch is deleted from share one.
const deletions = historyPerRepository<DeletedBranch>();
const redos = historyPerRepository<RedoEntry>();

/** Remembers a branch the user deleted, so Undo can put it back. A new action
 *  ends what Redo could take again. */
export function recordDeletion(repoPath: string, deleted: DeletedBranch): void {
	deletions.push(repoPath, deleted);
	redos.forget(repoPath);
}

/** Offers a delete to Undo again without ending what Redo could take, as a redo of
 *  the delete and an undo that did not land do. */
export function reofferDeletion(
	repoPath: string,
	deleted: DeletedBranch,
): void {
	deletions.push(repoPath, deleted);
}

export function lastDeletion(repoPath: string): DeletedBranch | null {
	return deletions.latest(repoPath);
}

export function takeDeletion(repoPath: string): DeletedBranch | null {
	return deletions.take(repoPath);
}

/**
 * The deleted branch Undo puts back with HEAD at `headOid`, or null when Undo
 * takes back a commit instead. A delete is later than every commit while HEAD has
 * not moved since it, and it is the latest left when what moved HEAD last cannot
 * be undone.
 */
export function deletionToUndo(
	repoPath: string,
	now: { headOid: string | null; canUndoCommit: boolean },
): DeletedBranch | null {
	const deletion = deletions.latest(repoPath);
	if (deletion === null) return null;
	if (deletion.head_oid === now.headOid || !now.canUndoCommit) return deletion;
	return null;
}

export function pushRedo(entry: RedoEntry): void {
	redos.push(entry.repoPath, entry);
}

export function pendingRedo(repoPath: string): RedoEntry | null {
	return redos.latest(repoPath);
}

export function takeRedo(repoPath: string): RedoEntry | null {
	return redos.take(repoPath);
}

/** Forget every repository's history. For tests only. */
export function _resetHistory(): void {
	deletions.clear();
	redos.clear();
}
