import type { PanelDiffKind } from "./comment-matching.js";

// Mirrors the Rust `RevSpec` enum (serde tag "type", camelCase variants). Which
// version of a file to read.
export type RevSpec =
	| { type: "workingTree" }
	| { type: "index" }
	| { type: "head" }
	| { type: "empty" }
	| { type: "commit"; oid: string };

// The "after" side rev for an inline diff of the given kind.
export function afterRev(diffKind: PanelDiffKind, commitOid: string): RevSpec {
	switch (diffKind) {
		case "unstaged":
		case "current_file":
			return { type: "workingTree" };
		case "staged":
			return { type: "index" };
		case "commit":
			return { type: "commit", oid: commitOid };
	}
}

// The "before" side rev for a split diff, mirroring Source's bases: unstaged is
// index→workdir, staged is HEAD→index, commit is first-parent→commit. A
// parentless (root) commit has no before side at all — the empty rev renders it
// as an all-added file.
//
// `compareBaseOid`, when given, overrides the commit case: a compare selection
// pairs renames across the whole base-to-target range (list_compare_files_inner
// in diff.rs), so the before side must read at that same base, not the
// target's first parent — otherwise a rename earlier in the range reads the
// old path at a rev where it's already gone (TRUNK-163).
export function beforeRev(
	diffKind: PanelDiffKind,
	parentOid: string | null,
	compareBaseOid?: string | null,
): RevSpec {
	switch (diffKind) {
		// A current-file view is not a diff: both sides are the working tree, so
		// the renderer sees no change and prints the file as it stands.
		case "current_file":
			return { type: "workingTree" };
		case "unstaged":
			return { type: "index" };
		case "staged":
			return { type: "head" };
		case "commit": {
			const oid = compareBaseOid ?? parentOid;
			return oid ? { type: "commit", oid } : { type: "empty" };
		}
	}
}
