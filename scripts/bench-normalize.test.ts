import { describe, expect, it } from "vitest";
import { NormalizeError, normalize } from "./bench-normalize.js";
import recordedRun from "./fixtures/bench-33125031901.txt?raw";

function bench(name: string, value: string, deviation = "1"): string {
	return `test ${name} ... bench: ${value} ns/iter (+/- ${deviation})`;
}

function expectNormalizeError(input: string, message: string): void {
	const act = () => normalize(input);
	expect(act).toThrowError(NormalizeError);
	expect(act).toThrowError(new NormalizeError(message));
}

const CALIBRATIONS = [
	bench("calibration/syntect-v1", "2,000,000"),
	bench("calibration/git2-v1", "500,000"),
	bench("calibration/worktree-v1", "250,000"),
].join("\n");

describe("normalize", () => {
	it("divides each benchmark by its class calibration", () => {
		const input = `${CALIBRATIONS}\n${bench("enrich_ts_new_perfile", "8,000,000")}`;

		const output = normalize(input);

		expect(output).toContain(
			"test norm/syntect-v1/enrich_ts_new_perfile ... bench: 4000000 ns/iter",
		);
	});

	it("divides a git2-class benchmark by the git2 calibration", () => {
		const input = `${CALIBRATIONS}\n${bench("snapshot/10k", "1,500,000")}`;

		const output = normalize(input);

		expect(output).toContain(
			"test norm/git2-v1/snapshot/10k ... bench: 3000000 ns/iter",
		);
	});

	it.each([
		"diff_unstaged_inner",
		"get_status_inner",
		"stage_hunk_inner",
		"ipc_round_trip/diff_unstaged",
	])("puts $name in the fresh working-tree series", (name) => {
		const input = `${CALIBRATIONS}\n${bench(name, "500,000")}`;

		const output = normalize(input);

		expect(output).toBe(
			`test norm/worktree-v1/${name} ... bench: 2000000 ns/iter (+/- 4)`,
		);
	});

	it.each(["ipc_round_trip/get_commit_graph", "ipc_round_trip/list_refs"])(
		"keeps $name in the git2 series",
		(name) => {
			const input = `${CALIBRATIONS}\n${bench(name, "1,000,000")}`;

			const output = normalize(input);

			expect(output).toBe(
				`test norm/git2-v1/${name} ... bench: 2000000 ns/iter (+/- 2)`,
			);
		},
	);

	it("scales the deviation by the same factor as the value", () => {
		const input = `${CALIBRATIONS}\n${bench("get_status_inner", "250,000", "5,000")}`;

		const output = normalize(input);

		expect(output).toBe(
			"test norm/worktree-v1/get_status_inner ... bench: 1000000 ns/iter (+/- 20000)",
		);
	});

	it("drops the calibration benchmarks from the output", () => {
		const output = normalize(
			`${CALIBRATIONS}\n${bench("list_refs_inner", "500,000")}`,
		);

		expect(output).not.toContain("calibration/");
	});

	it("drops an excluded benchmark", () => {
		const output = normalize(
			`${CALIBRATIONS}\n${bench("reviewdb_draft_write", "36,000")}`,
		);

		expect(output).not.toContain("reviewdb_draft_write");
	});

	it("ignores lines that are not benchmark results", () => {
		const input = `Running benches/bench_commands.rs\n${CALIBRATIONS}\n\n${bench("list_refs_inner", "500,000")}`;

		const output = normalize(input);

		expect(output.split("\n")).toEqual([
			"test norm/git2-v1/list_refs_inner ... bench: 1000000 ns/iter (+/- 2)",
		]);
	});

	describe("when a calibration benchmark is missing", () => {
		it("throws NormalizeError naming the calibration", () => {
			const input = `${bench("calibration/git2-v1", "500,000")}\n${bench("list_refs_inner", "500,000")}`;

			expectNormalizeError(
				input,
				"calibration/syntect-* is absent from the benchmark output",
			);
		});

		it("throws NormalizeError naming the working-tree calibration", () => {
			const input = [
				bench("calibration/syntect-v1", "2,000,000"),
				bench("calibration/git2-v1", "500,000"),
				bench("stage_hunk_inner", "500,000"),
			].join("\n");

			expectNormalizeError(
				input,
				"calibration/worktree-* is absent from the benchmark output",
			);
		});
	});

	describe("when calibration generations overlap", () => {
		it("rejects two generations for one workload", () => {
			const input = `${CALIBRATIONS}\n${bench("calibration/worktree-v2", "250,000")}`;

			expectNormalizeError(
				input,
				"calibration/worktree-* appears more than once in the benchmark output",
			);
		});
	});

	describe("when a benchmark belongs to no class", () => {
		it("throws NormalizeError naming the benchmark", () => {
			const input = `${CALIBRATIONS}\n${bench("brand_new_inner", "1,000")}`;

			expectNormalizeError(
				input,
				"brand_new_inner belongs to no class and is not excluded",
			);
		});
	});

	describe("when the input is a CI run recorded before the calibrations existed", () => {
		it("reports the missing calibration, having classified every benchmark in it", () => {
			expectNormalizeError(
				recordedRun,
				"calibration/syntect-* is absent from the benchmark output",
			);
		});
	});
});
