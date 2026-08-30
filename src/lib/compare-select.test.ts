import { describe, expect, it } from "vitest";
import {
	cmdClick,
	plainClick,
	type SelectionState,
	shiftClick,
	swapCompare,
} from "./compare-select.js";

const none: SelectionState = { selectedOid: null, compare: null };

// Display order matches the graph: newest first. C2 is B's child on a side
// branch; A1 is a root commit.
const order = ["C2", "B2", "A3", "A2", "A1"];
const parents: Record<string, string | null> = {
	C2: "B2",
	B2: "A2",
	A3: "A2",
	A2: "A1",
	A1: null,
};
const firstParentOf = (oid: string) => parents[oid] ?? null;

describe("cmdClick", () => {
	it("selects the commit when nothing is selected", () => {
		expect(cmdClick(none, "A3")).toEqual({ selectedOid: "A3", compare: null });
	});

	it("pairs with the current selection in selection order: first pick is Base", () => {
		const s = cmdClick({ selectedOid: "A3", compare: null }, "C2");
		expect(s).toEqual({
			selectedOid: "A3",
			compare: { baseOid: "A3", targetOid: "C2", picked: ["A3", "C2"] },
		});
	});

	it("deselects when the only selected commit is cmd-clicked", () => {
		expect(cmdClick({ selectedOid: "A3", compare: null }, "A3")).toEqual(none);
	});

	it("dissolves the pair to the other member when one member is cmd-clicked", () => {
		const paired = cmdClick({ selectedOid: "A3", compare: null }, "C2");
		expect(cmdClick(paired, "A3")).toEqual({
			selectedOid: "C2",
			compare: null,
		});
		expect(cmdClick(paired, "C2")).toEqual({
			selectedOid: "A3",
			compare: null,
		});
	});

	it("re-pairs from the anchor when a third commit is cmd-clicked", () => {
		const paired = cmdClick({ selectedOid: "A3", compare: null }, "C2");
		expect(cmdClick(paired, "B2")).toEqual({
			selectedOid: "A3",
			compare: { baseOid: "A3", targetOid: "B2", picked: ["A3", "B2"] },
		});
	});
});

describe("shiftClick", () => {
	it("selects the commit when nothing is selected", () => {
		expect(shiftClick(none, "A3", order, firstParentOf)).toEqual({
			selectedOid: "A3",
			compare: null,
		});
	});

	it("compares parent(oldest) to newest so every commit in the range shows", () => {
		const s = shiftClick(
			{ selectedOid: "A3", compare: null },
			"C2",
			order,
			firstParentOf,
		);
		expect(s.compare).toEqual({
			baseOid: "A2",
			targetOid: "C2",
			picked: ["A3", "C2"],
		});
	});

	it("uses chronological direction regardless of click order", () => {
		const s = shiftClick(
			{ selectedOid: "C2", compare: null },
			"A3",
			order,
			firstParentOf,
		);
		expect(s.compare).toEqual({
			baseOid: "A2",
			targetOid: "C2",
			picked: ["C2", "A3"],
		});
	});

	it("uses the empty tree when the oldest endpoint is a root commit", () => {
		const s = shiftClick(
			{ selectedOid: "B2", compare: null },
			"A1",
			order,
			firstParentOf,
		);
		expect(s.compare).toEqual({
			baseOid: null,
			targetOid: "B2",
			picked: ["B2", "A1"],
		});
	});

	it("keeps the state when the anchor itself is shift-clicked", () => {
		const s: SelectionState = { selectedOid: "A3", compare: null };
		expect(shiftClick(s, "A3", order, firstParentOf)).toEqual(s);
	});
});

describe("plainClick", () => {
	it("single-selects and clears any compare", () => {
		const paired = cmdClick({ selectedOid: "A3", compare: null }, "C2");
		expect(plainClick(paired, "B2")).toEqual({
			selectedOid: "B2",
			compare: null,
		});
	});
});

describe("swapCompare", () => {
	it("exchanges Base and Target", () => {
		const paired = cmdClick({ selectedOid: "A3", compare: null }, "C2");
		expect(swapCompare(paired).compare).toEqual({
			baseOid: "C2",
			targetOid: "A3",
			picked: ["A3", "C2"],
		});
	});

	it("cannot swap an empty-tree Base", () => {
		const s = shiftClick(
			{ selectedOid: "B2", compare: null },
			"A1",
			order,
			firstParentOf,
		);
		expect(swapCompare(s)).toEqual(s);
	});
});
