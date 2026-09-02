import type { RefLabel, RefType } from "./types.js";

/**
 * Which refs the user has hidden from the graph.
 *
 * Mirrors the Rust `RefVisibility` field for field, because the whole value crosses the
 * `set_ref_visibility` boundary. A ref is hidden when any rule matches it, and hiding one
 * takes its pill and every commit only it reaches out of the graph.
 *
 * HEAD's own branch is never hidden, whatever the rules say: column 0, the WIP row and the
 * head-lane extension all assume the checked-out branch is in the walk.
 */
export interface RefVisibility {
	/** Full ref names, as `RefLabel.name` carries them. */
	hiddenRefs: string[];
	/** Remote names — `origin` hides every `refs/remotes/origin/*`. */
	hiddenRemotes: string[];
	/** Stash commit OIDs. A stash has no stable name, so it is keyed by its commit. */
	hiddenStashes: string[];
	hideLocal: boolean;
	hideRemote: boolean;
	hideTags: boolean;
	hideStashes: boolean;
}

export const EVERYTHING_VISIBLE: RefVisibility = {
	hiddenRefs: [],
	hiddenRemotes: [],
	hiddenStashes: [],
	hideLocal: false,
	hideRemote: false,
	hideTags: false,
	hideStashes: false,
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

const SECTION_KEY = {
	LocalBranch: "hideLocal",
	RemoteBranch: "hideRemote",
	Tag: "hideTags",
	Stash: "hideStashes",
} as const satisfies Record<RefType, keyof RefVisibility>;

export function isSectionHidden(
	visibility: RefVisibility,
	section: RefType,
): boolean {
	return visibility[SECTION_KEY[section]] === true;
}

export function isRefHidden(visibility: RefVisibility, ref: RefLabel): boolean {
	if (ref.is_head) return false;
	if (isSectionHidden(visibility, ref.ref_type)) return true;

	if (ref.ref_type === "RemoteBranch") {
		const remote = remoteOf(ref.name);
		if (remote !== null && visibility.hiddenRemotes.includes(remote)) {
			return true;
		}
	}

	return visibility.hiddenRefs.includes(ref.name);
}

function withoutOrWith(list: string[], value: string): string[] {
	return list.includes(value)
		? list.filter((v) => v !== value)
		: [...list, value];
}

export function toggleRef(
	visibility: RefVisibility,
	ref: RefLabel,
): RefVisibility {
	return {
		...visibility,
		hiddenRefs: withoutOrWith(visibility.hiddenRefs, ref.name),
	};
}

export function toggleStash(
	visibility: RefVisibility,
	oid: string,
): RefVisibility {
	return {
		...visibility,
		hiddenStashes: withoutOrWith(visibility.hiddenStashes, oid),
	};
}

export function toggleRemote(
	visibility: RefVisibility,
	remote: string,
): RefVisibility {
	return {
		...visibility,
		hiddenRemotes: withoutOrWith(visibility.hiddenRemotes, remote),
	};
}

export function toggleSection(
	visibility: RefVisibility,
	section: RefType,
): RefVisibility {
	const key = SECTION_KEY[section];
	return { ...visibility, [key]: !visibility[key] };
}

export function isStashHidden(visibility: RefVisibility, oid: string): boolean {
	return visibility.hideStashes || visibility.hiddenStashes.includes(oid);
}
