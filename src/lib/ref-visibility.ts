import type { RefLabel } from "./types.js";

/**
 * Which refs the user has hidden from the graph.
 *
 * Mirrors the Rust `RefVisibility` field for field, because the whole value crosses the
 * `set_ref_visibility` boundary. Hiding a ref takes its pill and every commit only it
 * reaches out of the graph.
 *
 * Every hidden thing is named here individually. The sidebar's section and remote toggles
 * are bulk actions over the rows they cover, not rules of their own: a row is hidden if and
 * only if it appears in one of these lists. That is what keeps the sidebar honest — the eye
 * on a row always shows that row's own state, and a group icon can never contradict the
 * rows beneath it (João, 2026-09-02).
 *
 * HEAD's own branch is never hidden: column 0, the WIP row and the head-lane extension all
 * assume the checked-out branch is in the walk.
 */
export interface RefVisibility {
	/** Full ref names, as `RefLabel.name` carries them. */
	hiddenRefs: string[];
	/** Stash commit OIDs. A stash has no stable name, so it is keyed by its commit. */
	hiddenStashes: string[];
}

export const EVERYTHING_VISIBLE: RefVisibility = {
	hiddenRefs: [],
	hiddenStashes: [],
};

/**
 * The remote a `refs/remotes/<remote>/<branch>` name belongs to, or null.
 *
 * A remote name may itself contain slashes, so the branch cannot be split off from the
 * right. This takes the first segment, which is what the sidebar groups by.
 */
export function remoteOf(name: string): string | null {
	const rest = name.startsWith("refs/remotes/")
		? name.slice("refs/remotes/".length)
		: null;
	if (rest === null) return null;
	const first = rest.split("/")[0];
	return first === undefined || first === "" ? null : first;
}

/**
 * Whether this value hides nothing, matching the Rust side's `RefVisibility::is_empty`.
 *
 * Compares fields rather than identity: a value read back from prefs is a different object
 * with the same contents.
 */
export function hidesNothing(visibility: RefVisibility): boolean {
	return (
		visibility.hiddenRefs.length === 0 && visibility.hiddenStashes.length === 0
	);
}

/** A ref the user is not allowed to hide, so no toggle is offered for it. */
export function isHideable(ref: RefLabel): boolean {
	return !ref.is_head;
}

export function isRefHidden(visibility: RefVisibility, ref: RefLabel): boolean {
	if (!isHideable(ref)) return false;
	return visibility.hiddenRefs.includes(ref.name);
}

export function isStashHidden(visibility: RefVisibility, oid: string): boolean {
	return visibility.hiddenStashes.includes(oid);
}

function withHidden(list: string[], value: string, hidden: boolean): string[] {
	if (hidden) {
		return list.includes(value) ? list : [...list, value];
	}
	return list.filter((v) => v !== value);
}

export function setRefHidden(
	visibility: RefVisibility,
	ref: RefLabel,
	hidden: boolean,
): RefVisibility {
	if (!isHideable(ref)) return visibility;
	return {
		...visibility,
		hiddenRefs: withHidden(visibility.hiddenRefs, ref.name, hidden),
	};
}

export function toggleRef(
	visibility: RefVisibility,
	ref: RefLabel,
): RefVisibility {
	return setRefHidden(visibility, ref, !isRefHidden(visibility, ref));
}

export function setStashHidden(
	visibility: RefVisibility,
	oid: string,
	hidden: boolean,
): RefVisibility {
	return {
		...visibility,
		hiddenStashes: withHidden(visibility.hiddenStashes, oid, hidden),
	};
}

export function toggleStash(
	visibility: RefVisibility,
	oid: string,
): RefVisibility {
	return setStashHidden(visibility, oid, !isStashHidden(visibility, oid));
}

/**
 * How much of a sidebar group is hidden, which is all its toggle needs to render.
 *
 * Derived from the rows rather than stored, so the icon on a section or a remote always
 * agrees with the eyes beneath it.
 */
export type GroupState = "none" | "some" | "all";

export function groupState(
	visibility: RefVisibility,
	members: RefLabel[],
): GroupState {
	// HEAD's branch can never be hidden, so counting it would leave its section stuck at
	// "some" however many times the user clicked.
	const hideable = members.filter(isHideable);
	if (hideable.length === 0) return "none";

	const hidden = hideable.filter((ref) => isRefHidden(visibility, ref)).length;
	if (hidden === 0) return "none";
	return hidden === hideable.length ? "all" : "some";
}

/** Write `hidden` onto every member of a group, which is what a group toggle does. */
export function setGroupHidden(
	visibility: RefVisibility,
	members: RefLabel[],
	hidden: boolean,
): RefVisibility {
	return members.reduce(
		(acc, ref) => setRefHidden(acc, ref, hidden),
		visibility,
	);
}

export type StashGroupMember = { oid: string };

export function stashGroupState(
	visibility: RefVisibility,
	stashes: StashGroupMember[],
): GroupState {
	if (stashes.length === 0) return "none";

	const hidden = stashes.filter((s) => isStashHidden(visibility, s.oid)).length;
	if (hidden === 0) return "none";
	return hidden === stashes.length ? "all" : "some";
}

export function setStashGroupHidden(
	visibility: RefVisibility,
	stashes: StashGroupMember[],
	hidden: boolean,
): RefVisibility {
	return stashes.reduce(
		(acc, s) => setStashHidden(acc, s.oid, hidden),
		visibility,
	);
}
