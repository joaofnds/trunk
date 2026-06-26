import { describe, expect, it } from "vitest";
import { diffBarFractions } from "./diff-stat.js";

describe("diffBarFractions", () => {
	it("returns zero fractions when there are no changes", () => {
		expect(diffBarFractions(0, 0)).toEqual({ addFrac: 0, delFrac: 0 });
	});

	it("gives a pure-add commit only an add fraction", () => {
		const { addFrac, delFrac } = diffBarFractions(50, 0);
		expect(delFrac).toBe(0);
		expect(addFrac).toBeGreaterThan(0);
	});

	it("gives a pure-delete commit only a delete fraction", () => {
		const { addFrac, delFrac } = diffBarFractions(0, 50);
		expect(addFrac).toBe(0);
		expect(delFrac).toBeGreaterThan(0);
	});

	it("splits the bar evenly for a 50/50 commit", () => {
		const { addFrac, delFrac } = diffBarFractions(30, 30);
		expect(addFrac).toBeCloseTo(delFrac, 10);
	});

	it("fills the whole track once total reaches the cap", () => {
		const { addFrac, delFrac } = diffBarFractions(600, 600, 1000);
		expect(addFrac + delFrac).toBeCloseTo(1, 10);
	});

	it("never exceeds a full track beyond the cap", () => {
		const { addFrac, delFrac } = diffBarFractions(40000, 0, 1000);
		expect(addFrac).toBeLessThanOrEqual(1);
		expect(addFrac + delFrac).toBeLessThanOrEqual(1 + 1e-9);
	});

	it("scales monotonically: a bigger commit fills more of the track", () => {
		const small = diffBarFractions(10, 0);
		const big = diffBarFractions(1000, 0);
		expect(big.addFrac).toBeGreaterThan(small.addFrac);
	});

	it("preserves the add/delete ratio within the scaled width", () => {
		const { addFrac, delFrac } = diffBarFractions(75, 25);
		expect(addFrac / (addFrac + delFrac)).toBeCloseTo(0.75, 10);
	});
});
