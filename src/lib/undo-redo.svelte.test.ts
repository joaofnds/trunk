import { describe, expect, it } from "vitest";
import { createUndoRedoState, type UndoEntry } from "./undo-redo.svelte.js";

/** These tests are about stack behaviour, so the position and repository an
 *  entry belongs to only have to be present and distinct, not meaningful. */
function entry(subject: string, body: string | null = null): UndoEntry {
	return { subject, body, headOid: `oid-${subject}`, repoPath: "/repo" };
}

describe("createUndoRedoState", () => {
	it("starts with empty redoStack", () => {
		const mgr = createUndoRedoState();
		expect(mgr.state.redoStack).toHaveLength(0);
	});

	it("push adds entry", () => {
		const mgr = createUndoRedoState();
		mgr.push(entry("test"));
		expect(mgr.state.redoStack).toHaveLength(1);
	});

	it("pop returns last pushed entry (LIFO)", () => {
		const mgr = createUndoRedoState();
		mgr.push(entry("first"));
		mgr.push(entry("second", "desc"));
		const popped = mgr.pop();
		expect(popped).toEqual(entry("second", "desc"));
	});

	it("pop returns undefined on empty stack", () => {
		const mgr = createUndoRedoState();
		expect(mgr.pop()).toBeUndefined();
	});

	it("instances are independent", () => {
		const a = createUndoRedoState();
		const b = createUndoRedoState();
		a.push(entry("only-on-a"));
		expect(b.state.redoStack).toHaveLength(0);
		expect(b.pop()).toBeUndefined();
	});
});
