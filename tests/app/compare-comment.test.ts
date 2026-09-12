import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";

const FILE = "src/compare.ts";
const REPOSITORY: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: "const answer = 1;\n" },
		{ step: "commit", message: "Add answer" },
		{ step: "file", path: FILE, content: "const answer = 2;\n" },
		{ step: "commit", message: "Change answer" },
	],
};

describe("commenting on an arbitrary compare", () => {
	afterEach(teardown);

	it("withholds comment creation from the full-file view", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.repo.selectCompare("Add answer", "Change answer");
		await app.repo.openCompareFile(FILE);
		await app.diffPane.showFullFile();

		await app.review.selectNewLine(1);

		expect(app.review.showsCommentOnSelection()).toBe(false);
		expect(app.review.composerDraft()).toBeNull();
	});
});
