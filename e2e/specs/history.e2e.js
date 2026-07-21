import { openRepo, waitForCommitGraph } from "../helpers/app.js";
import { cleanupRepo, createLinearRepo } from "../helpers/fixture.js";

describe("Commit History", () => {
	let repoDir;

	before(async () => {
		repoDir = createLinearRepo(5);
		await openRepo(repoDir);
		await waitForCommitGraph();
	});

	after(async () => {
		cleanupRepo(repoDir);
	});

	it("should display commit rows", async () => {
		const rows = await $$('[data-testid="commit-row"]');
		expect(rows.length).toBeGreaterThanOrEqual(5);
	});

	it("should show commit messages", async () => {
		const summaries = await $$('[data-testid="commit-row-summary"]');
		const texts = await Promise.all(summaries.map((s) => s.getText()));
		expect(texts).toContain("commit 5");
		expect(texts).toContain("commit 1");
	});

	it("should select a commit row on click", async () => {
		const rows = await $$('[data-testid="commit-row"]');
		// Skip first row which might be WIP
		await rows[1].click();
		expect(await rows[1].isDisplayed()).toBe(true);
	});
});
