import { describe, expect, it } from "vitest";
import { outcomeOf, passFiles } from "./bench-passes.js";

const BASE = "1ea527ec0000000000000000000000000000000a";

describe("outcomeOf", () => {
	it("compares when both passes succeeded", () => {
		const outcome = outcomeOf({
			base: BASE,
			basePassed: true,
			headPassed: true,
		});

		expect(outcome).toEqual({ kind: "compare" });
	});

	describe("when the head pass failed", () => {
		it.each([true, false])(
			"fails the run whether or not the base passed (%s)",
			(basePassed) => {
				const outcome = outcomeOf({
					base: BASE,
					basePassed,
					headPassed: false,
				});

				expect(outcome).toEqual({
					kind: "fail",
					message: "the pass on the pushed commit failed",
				});
			},
		);
	});

	describe("when only the base pass failed", () => {
		it("warns and compares nothing", () => {
			const outcome = outcomeOf({
				base: BASE,
				basePassed: false,
				headPassed: true,
			});

			expect(outcome).toEqual({
				kind: "skip",
				warning: `The base pass at ${BASE} failed, so this run compares nothing.`,
			});
		});
	});
});

describe("passFiles", () => {
	it("names each side's raw and normalized output in the pass directory", () => {
		expect(passFiles("/passes", "base")).toEqual({
			raw: "/passes/base-output.txt",
			normalized: "/passes/base-normalized.txt",
		});
	});
});
