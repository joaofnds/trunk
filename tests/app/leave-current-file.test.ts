import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const UNTOUCHED = "src/untouched.ts";
const EDITED = "src/edited.ts";

const ONE_EDIT: RepoSpec = {
	steps: [
		{ step: "file", path: UNTOUCHED, content: "const answer = 42;\n" },
		{ step: "file", path: EDITED, content: "let count = 0;\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: EDITED, content: "let count = 1;\n" },
	],
};

describe("leaving a current-file view", () => {
	afterEach(teardown);

	it("shows the staging file selected after it, not the one the finder opened", async () => {
		const app = await setup({ repo: ONE_EDIT });
		await app.repo.open();
		await app.staging.open();
		await app.review.openPanel();
		await app.review.openFileFinder();
		await app.review.findFile("untouched");
		await waitFor("the narrowed list", () =>
			app.review.finderRows().length === 1 ? true : null,
		);
		await app.review.openTopFinderRow();
		await waitFor("the current-file content", () =>
			app.diffPane.contextLines().length > 0 ? true : null,
		);

		await app.staging.openFile(EDITED);

		const shown = await waitFor("the staging diff", () => {
			const added = app.staging.addedLines();
			return added.length > 0 ? added : null;
		});
		expect(shown).toEqual(["let count = 1;"]);
	});
});
