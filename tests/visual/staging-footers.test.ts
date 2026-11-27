import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mismatch } from "./baseline.js";
import { SuiteHarness, type VisualHarness } from "./harness.js";

/** The narrowest the detail pane gets (`DETAIL_PANE` in
 *  src/lib/side-panes.svelte.ts), where a footer's buttons have least room. */
const DETAIL_PANE_FLOOR = 200;

describe.concurrent("staging panel footers at the detail pane's floor", () => {
	const suite = new SuiteHarness();
	let harness: VisualHarness;

	beforeAll(async () => {
		harness = await suite.start({
			cases: ["01-commit-message", "10-nested-conflict"],
			pages: 2,
			runsUsersGit: true,
		});
	});

	afterAll(() => suite.teardown());

	test("keeps a collapsed section's filtered action visible under a full unstaged list", async (context) => {
		const files = Array.from({ length: 24 }, (_, i) => ({
			step: "file" as const,
			path: `file-${i}.ts`,
			content: "change",
		}));
		const header = await harness.filteredStagingHeader(
			{
				steps: [
					{ step: "file", path: "base.txt", content: "base" },
					{ step: "commit", message: "base" },
					...files,
				],
			},
			DETAIL_PANE_FLOOR,
			context,
		);

		expect(header).toEqual({
			sectionWidth: DETAIL_PANE_FLOOR,
			labelFits: true,
			actionFits: true,
			gutterCollapses: true,
		});
	});

	async function expectBaseline(name: string, capture: Buffer): Promise<void> {
		const reason = await mismatch(name, capture, (baseline, actual) =>
			harness.difference(baseline, actual),
		);

		expect(reason).toBeNull();
	}

	test("draws a stopped rebase's footer as its baseline shows", async (context) => {
		const capture = await harness.captureFooter("03-conflict-merge", context, {
			footer: "rebase-footer",
			detailPaneWidth: DETAIL_PANE_FLOOR,
			rebaseOnto: "feature",
		});

		await expectBaseline(
			`staging-footer__rebase__detail-${DETAIL_PANE_FLOOR}px`,
			capture,
		);
	});

	test("draws a stopped merge's footer as its baseline shows", async (context) => {
		const capture = await harness.captureFooter("nested-conflict", context, {
			footer: "merge-footer",
			detailPaneWidth: DETAIL_PANE_FLOOR,
		});

		await expectBaseline(
			`staging-footer__merge__detail-${DETAIL_PANE_FLOOR}px`,
			capture,
		);
	});
});
