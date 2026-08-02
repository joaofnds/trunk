import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRepo, waitForCommitGraph } from "../helpers/app.js";
import { cleanupRepo, createLinearRepo } from "../helpers/fixture.js";

describe("Staging Workflow", () => {
	let repoDir;

	before(async () => {
		repoDir = createLinearRepo(1);
		await openRepo(repoDir);
		await waitForCommitGraph();
	});

	after(async () => {
		cleanupRepo(repoDir);
	});

	it("should show unstaged file after modifying repo", async () => {
		writeFileSync(join(repoDir, "new-file.txt"), "hello e2e");

		await browser.waitUntil(
			async () => {
				const files = await $$('[data-testid="staging-file"]');
				return files.length > 0;
			},
			{ timeout: 15000, timeoutMsg: "Expected unstaged file to appear" },
		);

		const files = await $$('[data-testid="staging-file"]');
		expect(files.length).toBeGreaterThanOrEqual(1);
	});

	it("should stage a file by clicking its action button", async () => {
		const unstagedSection = await $('[data-testid="staging-unstaged-section"]');
		const fileRow = await unstagedSection.$('[data-testid="staging-file"]');
		const actionBtn = await fileRow.$("button");
		await actionBtn.click();

		await browser.waitUntil(
			async () => {
				const stagedSection = await $('[data-testid="staging-staged-section"]');
				const stagedFiles = await stagedSection.$$(
					'[data-testid="staging-file"]',
				);
				return stagedFiles.length > 0;
			},
			{
				timeout: 10000,
				timeoutMsg: "Expected file to appear in staged section",
			},
		);
	});

	it("should create a commit with subject", async () => {
		const subjectInput = await $('[data-testid="commit-form-subject"]');
		await subjectInput.setValue("E2E test commit");

		const submitBtn = await $('[data-testid="commit-form-submit"]');
		await submitBtn.click();

		await browser.waitUntil(
			async () => {
				const summaries = await $$('[data-testid="commit-row-summary"]');
				const texts = await Promise.all(summaries.map((s) => s.getText()));
				return texts.some((t) => t.includes("E2E test commit"));
			},
			{
				timeout: 15000,
				timeoutMsg: "Expected new commit to appear in graph",
			},
		);

		const inputValue = await subjectInput.getValue();
		expect(inputValue).toBe("");
	});
});
