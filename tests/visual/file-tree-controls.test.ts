import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { RepoSpec } from "../app/harness/host-client.js";
import { SuiteHarness, type VisualHarness } from "./harness.js";

const COMMIT = "Add a large file tree";
const ROOT_FILE = "readme.md";
const LAST_NESTED_FILE = "large/zz-last.ts";
const FILE_COUNT = 502;
const PANE_WIDTH = 200;
const STAGING_REPO: RepoSpec = {
	steps: [
		{ step: "file", path: ROOT_FILE, content: "root file" },
		{ step: "commit", message: "Add readme" },
		{ step: "file", path: "working/new.ts", content: "uncommitted file" },
	],
};
const COMMIT_REPO: RepoSpec = {
	steps: [
		{ step: "file", path: ROOT_FILE, content: "root file" },
		{ step: "file", path: "small/one.ts", content: "one" },
		...Array.from({ length: FILE_COUNT - 3 }, (_, index) => ({
			step: "file" as const,
			path: `large/file-${index}.ts`,
			content: "another file",
		})),
		{ step: "file", path: LAST_NESTED_FILE, content: "last nested file" },
		{ step: "commit", message: COMMIT },
	],
};

const suite = new SuiteHarness();
let harness: VisualHarness;
beforeAll(async () => {
	harness = await suite.start({ cases: [], pages: 1 });
});
afterAll(() => suite.teardown());

async function isHit(locator: Locator, signal: AbortSignal): Promise<boolean> {
	return locator.evaluate(
		(element) => {
			const { left, top, width, height } = element.getBoundingClientRect();
			const hit = document.elementFromPoint(left + width / 2, top + height / 2);
			return element.contains(hit);
		},
		undefined,
		{ signal },
	);
}

function fileControls(page: Page) {
	return {
		filter: page.getByRole("button", { name: "Filter files" }),
		bulk: page.getByRole("button", {
			name: /^(Expand|Collapse) all directories$/,
		}),
		mode: page.getByRole("switch", { name: "Switch to list view" }),
		expand: page.getByRole("button", { name: "Expand all directories" }),
		collapse: page.getByRole("button", { name: "Collapse all directories" }),
		input: page.getByRole("textbox", { name: "Filter files" }),
		close: page.getByRole("button", { name: "Close filter files" }),
	};
}

function isFocused(locator: Locator, signal: AbortSignal) {
	return locator.evaluate(
		(element) => element === document.activeElement,
		undefined,
		{ signal },
	);
}

test("fits the staging tree controls and filter at the pane minimum", async (context) => {
	const { signal } = context;
	const options = { signal };
	await harness.inspectFileTrees(
		STAGING_REPO,
		PANE_WIDTH,
		context,
		async (page) => {
			const { filter, bulk, mode, expand, collapse, input, close } =
				fileControls(page);

			await page.getByRole("treeitem", { name: /^working / }).waitFor(options);
			expect(
				(
					await page
						.getByTestId("staging-unstaged-section")
						.boundingBox(options)
				)?.width,
			).toBe(PANE_WIDTH);
			expect(
				await isHit(page.getByText("1 changed", { exact: true }), signal),
			).toBe(true);
			expect(
				await isHit(page.getByTitle("Copy main", { exact: true }), signal),
			).toBe(true);

			await mode.click(options);
			await page
				.getByRole("switch", { name: "Switch to tree view" })
				.click(options);
			const file = page.getByTitle("working/new.ts", { exact: true });
			await file.waitFor(options);
			await collapse.waitFor(options);

			await filter.focus(options);
			await page.keyboard.press("Tab");
			expect(await isFocused(collapse, signal)).toBe(true);
			await page.keyboard.press("Tab");
			expect(await isFocused(mode, signal)).toBe(true);
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Enter");
			await expand.waitFor(options);
			expect(await isFocused(expand, signal)).toBe(true);
			expect(await file.count()).toBe(0);
			await page.keyboard.press("Enter");
			await collapse.waitFor(options);
			expect(await isFocused(collapse, signal)).toBe(true);
			await file.waitFor(options);

			await filter.click(options);
			expect((await input.boundingBox(options))?.width).toBeGreaterThan(100);
			for (const control of [input, close, bulk, mode]) {
				expect(await isHit(control, signal)).toBe(true);
			}
			await input.fill("new.ts", options);
			await bulk.press("Escape", options);
			await filter.waitFor(options);
		},
	);
});

test("keeps the bulk action visible and reveals the keyboard cursor on entering a large commit tree", async (context) => {
	const { signal } = context;
	const options = { signal };
	await harness.inspectFileTrees(
		COMMIT_REPO,
		PANE_WIDTH,
		context,
		async (page) => {
			const { filter, bulk, mode, expand, collapse, input, close } =
				fileControls(page);

			await page
				.getByTestId("commit-row")
				.filter({ hasText: COMMIT })
				.click(options);
			const detail = page.getByTestId("commit-detail");
			const tree = detail.getByRole("tree");
			await detail.getByTitle(ROOT_FILE, { exact: true }).click(options);
			expect((await detail.boundingBox(options))?.width).toBe(PANE_WIDTH);
			const selectedDiff = page.locator(
				`[data-testid="diff-path"][data-path="${ROOT_FILE}"]`,
			);
			await selectedDiff.waitFor(options);
			await detail.getByRole("treeitem", { name: /^small / }).click(options);
			await expand.focus(options);
			expect(await isHit(expand, signal)).toBe(true);

			await page.keyboard.press("Enter");
			await collapse.waitFor(options);
			expect(await isHit(collapse, signal)).toBe(true);
			expect(await isFocused(collapse, signal)).toBe(true);
			await detail
				.getByTitle("large/file-0.ts", { exact: true })
				.waitFor(options);
			expect(await tree.getByRole("treeitem").count()).toBeLessThan(FILE_COUNT);

			await page.keyboard.press("Tab");
			expect(await isFocused(mode, signal)).toBe(true);
			await page.keyboard.press("Tab");
			expect(await isFocused(tree, signal)).toBe(true);
			const last = detail.getByTitle(LAST_NESTED_FILE, { exact: true });
			expect(await last.count()).toBe(1);
			const cursor = tree.getByRole("treeitem", { selected: true });
			expect(await cursor.getAttribute("data-path", options)).toBe(ROOT_FILE);
			expect(await isHit(cursor, signal)).toBe(true);
			expect(await tree.getByRole("treeitem").count()).toBeLessThan(FILE_COUNT);

			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Shift+Tab");
			expect(await isFocused(collapse, signal)).toBe(true);
			await page.keyboard.press("Enter");
			await expand.waitFor(options);
			expect(await detail.getByTitle(ROOT_FILE, { exact: true }).count()).toBe(
				1,
			);
			expect(await selectedDiff.count()).toBe(1);
			expect(
				await detail.getByTitle("small/one.ts", { exact: true }).count(),
			).toBe(0);

			await filter.click(options);
			expect((await input.boundingBox(options))?.width).toBeGreaterThan(100);
			for (const control of [input, close, bulk, mode]) {
				expect(await isHit(control, signal)).toBe(true);
			}
		},
	);
});
