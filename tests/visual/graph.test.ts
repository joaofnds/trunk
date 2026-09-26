import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mismatch } from "./baseline.js";
import { VisualHarness } from "./harness.js";

const GRAPH_REPOSITORIES = [
	"graph-lanes/01-behind-only",
	"graph-lanes/02-local-ahead-no-remote",
	"graph-lanes/03-detached-old",
	"graph-lanes/04-tiebreak-upstream-vs-topic",
	"graph-lanes/05-diverged",
	"graph-lanes/06-tag-only-chain",
	"graph-lanes/07-tag-on-unpulled",
	"graph-lanes/08-stash-on-tip-behind",
	"graph-lanes/09-branch-point-below-head",
	"graph-lanes/10-two-remotes",
	"graph-lanes/11-merge-in-head-chain",
	"graph-lanes/12-author-vs-committer",
	"graph-lanes/13-tall-linear",
	"graph-merges/01-octopus-merge",
	"graph-merges/02-criss-cross",
	"graph-merges/03-merge-of-merges",
	"graph-merges/04-three-topics",
	"graph-merges/05-sequential-merges",
	"graph-merges/06-merge-second-parent-newer",
	"graph-merges/07-fork-sibling-older",
	"graph-merges/08-fork-sibling-newer",
	"graph-merges/09-column-saturation",
	"graph-merges/10-merge-parent-left",
	"graph-merges/11-fork-in-left",
	"graph-merges/12-pagination-boundary",
	"graph-merges/13-freed-column-left",
	"graph-merges/14-spiral-right-before-left",
];

/** Narrower than the six lanes of 09-column-saturation, wide enough that its
 *  rails still draw: the state whose rails TRUNK-255 erased. */
const OVERFLOWING_GRAPH_COLUMN = 56;

describe.concurrent("commit graph", () => {
	let harness: VisualHarness;

	beforeAll(async () => {
		harness = await VisualHarness.setup();
	});

	afterAll(async () => {
		await harness?.teardown();
	});

	async function expectBaseline(name: string, capture: Buffer): Promise<void> {
		const reason = await mismatch(name, capture, (baseline, actual) =>
			harness.difference(baseline, actual),
		);

		expect(reason).toBeNull();
	}

	test("covers every repository the graph cases build", () => {
		expect(harness.graphRepositories()).toEqual(GRAPH_REPOSITORIES);
	});

	test.each(GRAPH_REPOSITORIES)(
		"draws %s as its baseline shows",
		async (repository) => {
			const capture = await harness.captureGraph(repository);

			await expectBaseline(repository.replace("/", "__"), capture);
		},
	);

	describe("when the graph column is narrower than its lanes", () => {
		test("draws the overflowing rails as the baseline shows", async () => {
			const capture = await harness.captureGraph(
				"graph-merges/09-column-saturation",
				{
					graphColumnWidth: OVERFLOWING_GRAPH_COLUMN,
				},
			);

			await expectBaseline(
				`graph-merges__09-column-saturation__graph-${OVERFLOWING_GRAPH_COLUMN}px`,
				capture,
			);
		});
	});
});
