export interface UndoEntry {
	/** The commit the undo took back. Redo moves the branch back to this exact
	 *  commit, so its oid, date and tree return as they were. */
	undoneOid: string;
	/** Where the undo left HEAD. The undone commit is a child of this position
	 *  and nowhere else, so the backend refuses a redo once HEAD has moved, and
	 *  the toolbar does not offer one. */
	headOid: string;
	/** The repository the undo happened in. A tab can be pointed at another
	 *  repository without remounting, and two clones share every oid, so the
	 *  position alone would call that a match. */
	repoPath: string;
}

export interface UndoRedoState {
	redoStack: UndoEntry[];
}

export interface UndoRedoManager {
	state: UndoRedoState;
	push(entry: UndoEntry): void;
	pop(): UndoEntry | undefined;
}

export function createUndoRedoState(): UndoRedoManager {
	const state: UndoRedoState = $state({ redoStack: [] as UndoEntry[] });

	return {
		state,
		push(entry: UndoEntry) {
			state.redoStack = [...state.redoStack, entry];
		},
		pop(): UndoEntry | undefined {
			if (state.redoStack.length === 0) return undefined;
			const entry = state.redoStack[state.redoStack.length - 1];
			state.redoStack = state.redoStack.slice(0, -1);
			return entry;
		},
	};
}
