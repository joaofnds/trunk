import { afterEach, describe, expect, it } from "vitest";
import type { AppDriver } from "./drivers/index.js";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/commented.ts";
const LINES = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`);
const REPOSITORY: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(LINES) },
		{ step: "commit", message: "Add file" },
		{
			step: "file",
			path: FILE,
			content: fileOf(LINES.with(5, "line 6 committed change")),
		},
		{ step: "commit", message: "Change file" },
		{
			step: "file",
			path: FILE,
			content: fileOf(LINES.with(5, "line 6 working tree change")),
		},
	],
};

describe("commenting on an entire file from hunk mode", () => {
	afterEach(teardown);

	it("uses the whole unstaged file range", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile(FILE);

		await commentOnTheFile(app);

		expect(app.diffPane.isInHunkMode()).toBe(true);
	});

	it("uses the whole staged file range", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.staging.open();
		await app.staging.stageFile(FILE);
		await app.staging.openStagedFile(FILE);

		await commentOnTheFile(app);

		expect(app.diffPane.isInHunkMode()).toBe(true);
	});

	it("uses the whole committed file range", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.repo.selectCommit("Change file");
		await app.repo.openCommitFile(FILE);

		await commentOnTheFile(app);

		expect(app.diffPane.isInHunkMode()).toBe(true);
	});
});

async function commentOnTheFile(app: AppDriver): Promise<void> {
	await app.review.commentOnFile();

	const draft = await waitFor("the whole-file composer", () =>
		app.review.composerDraft(),
	);
	expect(draft.range).toBe("Comments on lines 1-12");
}

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}
