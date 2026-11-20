import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "notes.txt";

/** One line that gains trailing spaces and nothing else, so ignoring
 *  whitespace leaves the file with no hunk at all. */
const TRAILING_SPACES_ONLY: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: "first\nsecond\nthird\n" },
		{ step: "commit", message: "Add notes" },
		{ step: "file", path: FILE, content: "first\nsecond   \nthird\n" },
	],
};

describe("a file whose only change is whitespace", () => {
	afterEach(teardown);

	it("shows its change again from the empty view ignoring whitespace left", async () => {
		const app = await setup({ repo: TRAILING_SPACES_ONLY });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile(FILE);
		await waitFor("the file's hunk", () =>
			app.staging.hunkHeaders().length === 1 ? true : null,
		);
		await app.diffPane.toggleIgnoreWhitespace();

		await app.diffPane.showWhitespaceChanges();

		const shown = await waitFor("the whitespace hunk to come back", () => {
			const showing = app.staging.hunkHeaders();
			return showing.length === 1 ? showing : null;
		});
		expect(shown).toEqual(["@@ -1,3 +1,3 @@"]);
	});
});
