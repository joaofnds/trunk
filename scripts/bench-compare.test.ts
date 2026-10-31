import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { passFiles, type Side } from "./bench-passes.js";

const SCRIPT = join(import.meta.dirname, "bench-compare.ts");

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "bench-compare-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writePass(side: Side, normalized: number) {
	const files = passFiles(directory, side);
	writeFileSync(
		files.normalized,
		`test norm/git2-v1/snapshot/10k ... bench: ${normalized} ns/iter (+/- 1)\n`,
	);
	writeFileSync(
		files.raw,
		"test snapshot/10k ... bench: 500 ns/iter (+/- 1)\n",
	);
}

function compareDirectory() {
	return spawnSync("bun", ["run", SCRIPT, directory], {
		encoding: "utf8",
		env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
	});
}

describe("bench-compare", () => {
	it("exits 0 when every benchmark is within the threshold", () => {
		writePass("base", 1_000_000);
		writePass("head", 1_300_000);

		const result = compareDirectory();

		expect(result.status).toBe(0);
	});

	describe("when a benchmark slowed past the threshold", () => {
		it("exits 1 naming it", () => {
			writePass("base", 1_000_000);
			writePass("head", 1_310_000);

			const result = compareDirectory();

			expect(result).toMatchObject({
				status: 1,
				stderr:
					"bench-compare: slower than 1.30x the base: norm/git2-v1/snapshot/10k 1.310x\n",
			});
		});
	});

	describe("when a pass file is missing", () => {
		it("exits 1 naming the file", () => {
			writePass("base", 1_000_000);

			const result = compareDirectory();

			expect(result).toMatchObject({
				status: 1,
				stderr: `bench-compare: ${passFiles(directory, "head").normalized} is absent from the pass directory\n`,
			});
		});
	});
});
