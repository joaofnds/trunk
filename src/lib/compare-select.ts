// Compare selection (TRUNK-001): the pure state machine behind picking two
// commits in the graph and viewing the Base → Target diff between them.
// Direction is selection order — the first pick is Base — except for a
// shift-click range, which always compares parent(oldest) → newest so every
// commit in the range contributes its changes (GitKraken behavior).

/** Modifier keys on a commit-row click, as the compare gesture reads them. */
export interface SelectModifiers {
	/** Cmd/Ctrl: pair this commit with the anchor. */
	compare?: boolean;
	/** Shift: range-compare from the anchor to this commit. */
	range?: boolean;
}

export interface ComparePair {
	/** Left/old side. `null` means the empty tree (a range rooted at a root commit). */
	baseOid: string | null;
	/** Right/new side. */
	targetOid: string;
	/** The two graph rows the user picked, in click order — the highlight set. */
	picked: [string, string];
}

export interface SelectionState {
	/** The single-selection anchor; the first pick, and Base of a cmd-click pair. */
	selectedOid: string | null;
	compare: ComparePair | null;
}

export function plainClick(_s: SelectionState, oid: string): SelectionState {
	return { selectedOid: oid, compare: null };
}

export function cmdClick(s: SelectionState, oid: string): SelectionState {
	if (s.compare) {
		const { baseOid, targetOid } = s.compare;
		if (oid === baseOid) return { selectedOid: targetOid, compare: null };
		if (oid === targetOid && baseOid !== null)
			return { selectedOid: baseOid, compare: null };
	}
	if (s.selectedOid === null) return { selectedOid: oid, compare: null };
	if (s.selectedOid === oid) return { selectedOid: null, compare: null };
	return {
		selectedOid: s.selectedOid,
		compare: {
			baseOid: s.selectedOid,
			targetOid: oid,
			picked: [s.selectedOid, oid],
		},
	};
}

/**
 * Range compare between the anchor and the shift-clicked row. `displayOrder`
 * is the graph's row order, newest first; `firstParentOf` resolves a loaded
 * commit's first parent, `null` for a root.
 */
export function shiftClick(
	s: SelectionState,
	oid: string,
	displayOrder: string[],
	firstParentOf: (oid: string) => string | null,
): SelectionState {
	const anchor = s.selectedOid;
	if (anchor === null) return { selectedOid: oid, compare: null };
	if (anchor === oid) return s;
	const anchorIdx = displayOrder.indexOf(anchor);
	const oidIdx = displayOrder.indexOf(oid);
	if (anchorIdx === -1 || oidIdx === -1)
		return { selectedOid: oid, compare: null };
	const oldest = anchorIdx > oidIdx ? anchor : oid;
	const newest = anchorIdx > oidIdx ? oid : anchor;
	return {
		selectedOid: anchor,
		compare: {
			baseOid: firstParentOf(oldest),
			targetOid: newest,
			picked: [anchor, oid],
		},
	};
}

/** Flip the diff direction. An empty-tree Base has no commit to become Target. */
export function swapCompare(s: SelectionState): SelectionState {
	if (!s.compare || s.compare.baseOid === null) return s;
	return {
		selectedOid: s.selectedOid,
		compare: {
			baseOid: s.compare.targetOid,
			targetOid: s.compare.baseOid,
			picked: s.compare.picked,
		},
	};
}
