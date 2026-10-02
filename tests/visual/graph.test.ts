import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clearDifferences, mismatch } from "./baseline.js";
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
	"kitchen-sink",
	"stash-lanes/01-clean-inline",
	"stash-lanes/02-dirty-tracked",
	"stash-lanes/03-dirty-untracked",
	"stash-lanes/04-dirty-staged",
	"stash-lanes/05-dirty-conflicted",
	"stash-lanes/06-ignored-stays-inline",
	"stash-lanes/07-multi-stash-clean",
	"stash-lanes/08-multi-stash-dirty",
	"stash-lanes/09-topic-above-parent",
	"stash-lanes/10-topic-below-parent",
	"stash-lanes/11-stash-parent-mid-chain",
	"stash-lanes/12-orphan-stash",
	"stash-lanes/13-detached-head",
	"stash-lanes/14-merge-tip",
	"stash-lanes/15-backdated-stash",
	"stash-lanes/16-bare-repo.git",
	"stash-lanes/17-no-stash-dirty",
	"stash-lanes/18-many-files",
	"stash-lanes/19-two-backdated",
	"stash-lanes/20-stash-on-stash",
	"stash-lanes/21-tagged-stash",
];

/** Narrower than the six lanes of 09-column-saturation, wide enough that its
 *  rails still draw: the state whose rails TRUNK-255 erased. */
const OVERFLOWING_GRAPH_COLUMN = 56;

/** Far enough that lanes sit past both edges of the overflowing column. */
const PANNED_PARTWAY = 20;

describe.concurrent("commit graph", () => {
	let harness: VisualHarness;

	beforeAll(async () => {
		clearDifferences();
		harness = await VisualHarness.setup();
		await harness.warmUp();
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

	test.for(GRAPH_REPOSITORIES)(
		"draws %s as its baseline shows",
		async (repository, context) => {
			const capture = await harness.captureGraph(repository, context);

			await expectBaseline(repository.replace("/", "__"), capture);
		},
	);

	describe("when the graph column is narrower than its lanes", () => {
		test("draws the overflowing rails as the baseline shows", async (context) => {
			const capture = await harness.captureGraph(
				"graph-merges/09-column-saturation",
				context,
				{
					graphColumnWidth: OVERFLOWING_GRAPH_COLUMN,
				},
			);

			await expectBaseline(
				`graph-merges__09-column-saturation__graph-${OVERFLOWING_GRAPH_COLUMN}px`,
				capture,
			);
		});

		test("draws the rails of a column panned partway as the baseline shows", async (context) => {
			const capture = await harness.captureGraph(
				"graph-merges/09-column-saturation",
				context,
				{
					graphColumnWidth: OVERFLOWING_GRAPH_COLUMN,
					pan: PANNED_PARTWAY,
				},
			);

			await expectBaseline(
				`graph-merges__09-column-saturation__graph-${OVERFLOWING_GRAPH_COLUMN}px__panned-${PANNED_PARTWAY}px`,
				capture,
			);
		});
	});
});
