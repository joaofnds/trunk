import { describe, expect, it } from "vitest";
import { outcomeOf, passFiles, workspaceBuildOf } from "./bench-passes.js";

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
	it("names each side's build, raw and normalized output in the pass directory", () => {
		expect(passFiles("/passes", "base")).toEqual({
			build: "/passes/base-build.jsonl",
			raw: "/passes/base-output.txt",
			normalized: "/passes/base-normalized.txt",
		});
	});
});

const GIT_CRATE = "path+file:///work/trunk/src-tauri/git#trunk-git@0.1.0";
const REVIEW_CRATE =
	"path+file:///work/trunk/src-tauri/review#trunk-review@0.1.0";
const APP_CRATE = "path+file:///work/trunk/src-tauri#trunk@0.59.0";
const REGISTRY_CRATE =
	"registry+https://github.com/rust-lang/crates.io-index#git2@0.21.0";

function artifact(packageId: string, fresh: boolean): string {
	return JSON.stringify({
		reason: "compiler-artifact",
		package_id: packageId,
		fresh,
	});
}

function cargoOutput(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("workspaceBuildOf", () => {
	it("lists every workspace crate the pass compiled and none reused", () => {
		const messages = cargoOutput([
			artifact(GIT_CRATE, false),
			artifact(REVIEW_CRATE, false),
			artifact(APP_CRATE, false),
			JSON.stringify({ reason: "build-finished", success: true }),
		]);

		expect(workspaceBuildOf(messages)).toEqual({
			compiled: [GIT_CRATE, REVIEW_CRATE, APP_CRATE],
			reused: [],
		});
	});

	it("leaves out registry dependencies an earlier build compiled", () => {
		const messages = cargoOutput([
			artifact(REGISTRY_CRATE, true),
			artifact(APP_CRATE, false),
		]);

		expect(workspaceBuildOf(messages)).toEqual({
			compiled: [APP_CRATE],
			reused: [],
		});
	});

	it("skips the blank and plain-text lines around cargo's messages", () => {
		const messages = cargoOutput([
			"",
			"   Compiling trunk v0.59.0",
			artifact(APP_CRATE, false),
			"",
		]);

		expect(workspaceBuildOf(messages)).toEqual({
			compiled: [APP_CRATE],
			reused: [],
		});
	});

	describe("when a workspace crate came from an earlier build", () => {
		it("names each crate the pass reused, once", () => {
			const messages = cargoOutput([
				artifact(GIT_CRATE, true),
				artifact(REVIEW_CRATE, true),
				artifact(APP_CRATE, false),
				artifact(GIT_CRATE, true),
			]);

			expect(workspaceBuildOf(messages)).toEqual({
				compiled: [APP_CRATE],
				reused: [GIT_CRATE, REVIEW_CRATE],
			});
		});
	});

	describe("when a message line is not JSON", () => {
		it("throws a syntax error", () => {
			const messages = cargoOutput(['{"reason": "compiler-artifact",']);

			expect(() => workspaceBuildOf(messages)).toThrow(SyntaxError);
		});
	});
});
