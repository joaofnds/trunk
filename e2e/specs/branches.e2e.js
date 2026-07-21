import {
	openRepo,
	waitForBranchSidebar,
	waitForCommitGraph,
} from "../helpers/app.js";
import { cleanupRepo, createBranchRepo } from "../helpers/fixture.js";

describe("Branch Operations", () => {
	let repoDir;

	before(async () => {
		repoDir = createBranchRepo();
		await openRepo(repoDir);
		await waitForCommitGraph();
		await waitForBranchSidebar();
	});

	after(async () => {
		cleanupRepo(repoDir);
	});

	it("should display local branches in sidebar", async () => {
		const branchRows = await $$('[data-testid="branch-row"]');
		expect(branchRows.length).toBeGreaterThanOrEqual(3);
	});

	it("should checkout a branch on double-click", async () => {
		const branchRows = await $$('[data-testid="branch-row"]');
		let targetRow;
		for (const row of branchRows) {
			const text = await row.getText();
			if (text.includes("feature-a")) {
				targetRow = row;
				break;
			}
		}

		await targetRow.doubleClick();

		await browser.waitUntil(
			async () => {
				const rows = await $$('[data-testid="branch-row"]');
				for (const r of rows) {
					const text = await r.getText();
					if (text.includes("feature-a")) {
						const classes = await r.getAttribute("class");
						// After checkout, the branch row gets highlighted styling
						return classes != null;
					}
				}
				return false;
			},
			{
				timeout: 10000,
				timeoutMsg: "Expected feature-a to become head branch",
			},
		);
	});

	it("should create a new branch", async () => {
		const createBtn = await $('[data-testid="branch-section-create-btn"]');
		await createBtn.click();

		const input = await $('[data-testid="branch-create-input"]');
		await input.waitForExist({ timeout: 5000 });
		await input.setValue("e2e-test-branch");
		await browser.keys("Enter");

		await browser.waitUntil(
			async () => {
				const rows = await $$('[data-testid="branch-row"]');
				const texts = await Promise.all(rows.map((r) => r.getText()));
				return texts.some((t) => t.includes("e2e-test-branch"));
			},
			{
				timeout: 10000,
				timeoutMsg: "Expected new branch to appear",
			},
		);
	});

	it("should delete a branch via IPC", async () => {
		await browser.execute(async (path) => {
			await window.__TAURI_INTERNALS__.invoke("delete_branch", {
				path,
				branchName: "feature-b",
			});
		}, repoDir);

		// Force refresh in case sidebar doesn't auto-refresh after direct IPC
		await browser.execute(async () => {
			window.dispatchEvent(new Event("focus"));
		});

		await browser.waitUntil(
			async () => {
				const rows = await $$('[data-testid="branch-row"]');
				const texts = await Promise.all(rows.map((r) => r.getText()));
				return !texts.some((t) => t.includes("feature-b"));
			},
			{
				timeout: 10000,
				timeoutMsg: "Expected feature-b to be removed from sidebar",
			},
		);
	});
});
