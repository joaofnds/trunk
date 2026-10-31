import { describe, expect, it } from "vitest";
import { ComparisonError, compare, summarize } from "./bench-comparison.js";

function bench(name: string, value: number): string {
	return `test ${name} ... bench: ${value} ns/iter (+/- 1)`;
}

function side(normalized: string[], raw: string[]) {
	return { normalized: normalized.join("\n"), raw: raw.join("\n") };
}

function snapshot(normalized: number, raw: number) {
	return side(
		[bench("norm/git2-v1/snapshot/10k", normalized)],
		[bench("snapshot/10k", raw)],
	);
}

describe("compare", () => {
	it("names a benchmark that slowed past the threshold with its ratio", () => {
		const base = side(
			[
				bench("norm/git2-v1/snapshot/10k", 1_000_000),
				bench("norm/worktree-v1/get_status_inner", 1_000_000),
			],
			[bench("snapshot/10k", 500), bench("get_status_inner", 250)],
		);
		const head = side(
			[
				bench("norm/git2-v1/snapshot/10k", 1_310_000),
				bench("norm/worktree-v1/get_status_inner", 1_000_000),
			],
			[bench("snapshot/10k", 500), bench("get_status_inner", 250)],
		);

		const comparison = compare({ base, head });

		expect(comparison.regressions).toEqual([
			{ name: "norm/git2-v1/snapshot/10k", ratio: 1.31, rawRatio: 1 },
		]);
	});

	it("gates on the normalized ratio, not the raw one", () => {
		const comparison = compare({
			base: snapshot(1_000_000, 500),
			head: snapshot(1_000_000, 1_000),
		});

		expect(comparison.regressions).toEqual([]);
	});

	it("keeps every compared benchmark in the rows", () => {
		const comparison = compare({
			base: snapshot(1_000_000, 500),
			head: snapshot(1_000_000, 500),
		});

		expect(comparison.rows).toEqual([
			{ name: "norm/git2-v1/snapshot/10k", ratio: 1, rawRatio: 1 },
		]);
	});

	it("reports the raw ratio beside the normalized one", () => {
		const comparison = compare({
			base: snapshot(1_000_000, 500),
			head: snapshot(1_000_000, 250),
		});

		expect(comparison.rows[0].rawRatio).toBe(0.5);
	});

	describe("when a benchmark reads exactly the threshold", () => {
		it("reports no regression", () => {
			const comparison = compare({
				base: snapshot(1_000_000, 500),
				head: snapshot(1_300_000, 500),
			});

			expect(comparison.regressions).toEqual([]);
		});
	});

	describe("when a series exists on one side only", () => {
		const base = side(
			[bench("norm/worktree-v1/stage_hunk_inner", 1_000_000)],
			[bench("stage_hunk_inner", 500)],
		);
		const head = side(
			[bench("norm/staging-v1/stage_hunk_inner", 2_000_000)],
			[bench("stage_hunk_inner", 1_000)],
		);

		it("lists each one-sided series", () => {
			const comparison = compare({ base, head });

			expect(comparison).toMatchObject({
				baseOnly: ["norm/worktree-v1/stage_hunk_inner"],
				headOnly: ["norm/staging-v1/stage_hunk_inner"],
			});
		});

		it("gates neither", () => {
			const comparison = compare({ base, head });

			expect(comparison).toMatchObject({ rows: [], regressions: [] });
		});
	});

	describe("when the raw output lacks a compared benchmark", () => {
		it("throws ComparisonError naming it", () => {
			const base = snapshot(1_000_000, 500);
			const head = { ...snapshot(1_000_000, 500), raw: "" };

			const act = () => compare({ base, head });

			expect(act).toThrowError(
				new ComparisonError("snapshot/10k is absent from the raw output"),
			);
		});
	});
});

describe("summarize", () => {
	it("tabulates each ratio and marks the one over the threshold", () => {
		const comparison = compare({
			base: side(
				[
					bench("norm/git2-v1/snapshot/10k", 1_000_000),
					bench("norm/git2-v1/list_refs_inner", 1_000_000),
				],
				[bench("snapshot/10k", 1_000), bench("list_refs_inner", 1_000)],
			),
			head: side(
				[
					bench("norm/git2-v1/snapshot/10k", 1_325_000),
					bench("norm/git2-v1/list_refs_inner", 1_281_000),
				],
				[bench("snapshot/10k", 844), bench("list_refs_inner", 1_100)],
			),
		});

		const summary = summarize(comparison);

		expect(summary).toBe(
			[
				"| Benchmark | Normalized | Raw | Verdict |",
				"|---|---|---|---|",
				"| norm/git2-v1/snapshot/10k | 1.325 | 0.844 | slower than 1.30x |",
				"| norm/git2-v1/list_refs_inner | 1.281 | 1.100 | within 1.30x |",
			].join("\n"),
		);
	});

	it("lists the one-sided series as not gated", () => {
		const comparison = compare({
			base: side(
				[bench("norm/worktree-v1/stage_hunk_inner", 1)],
				[bench("stage_hunk_inner", 1)],
			),
			head: side(
				[bench("norm/staging-v1/stage_hunk_inner", 1)],
				[bench("stage_hunk_inner", 1)],
			),
		});

		const summary = summarize(comparison);

		expect(summary.split("\n").slice(2)).toEqual([
			"",
			"Not gated, only in the base: norm/worktree-v1/stage_hunk_inner",
			"Not gated, only in the head: norm/staging-v1/stage_hunk_inner",
		]);
	});
});
