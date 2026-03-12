interface UndoEntry {
  subject: string;
  body: string | null;
}

export const undoRedoState = $state({
  redoStack: [] as UndoEntry[],
});

export function pushToRedoStack(entry: UndoEntry) {
  undoRedoState.redoStack = [...undoRedoState.redoStack, entry];
}

export function popFromRedoStack(): UndoEntry | undefined {
  const stack = undoRedoState.redoStack;
  if (stack.length === 0) return undefined;
  const entry = stack[stack.length - 1];
  undoRedoState.redoStack = stack.slice(0, -1);
  return entry;
}

export function clearRedoStack() {
  undoRedoState.redoStack = [];
}
