import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/main.ts";

const NUMBERED = Array.from({ length: 24 }, (_, at) => `line ${at + 1}`);
const REWRITTEN = NUMBERED.with(2, "line 3 CHANGED");

const COMMITTED = fileOf(NUMBERED);
/** One line rewritten near the top and three inserted near the bottom: two
 *  hunks, the second of them pure insertions. */
const WORKING = fileOf(REWRITTEN.toSpliced(19, 0, "extra a", "extra b", "extra c"));

/** A `file` step after the last `commit` stages nothing — the builder adds to
 *  the index only at `Commit` — so this seeds an unstaged modification. */
const TWO_HUNK_EDIT: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: COMMITTED },
		{ step: "commit", message: "Add main" },
		{ step: "file", path: FILE, content: WORKING },
	],
};

describe("a working-tree file with two hunks of changes", () => {
	afterEach(teardown);

	it("stages one hunk on its own", async () => {
		const app = await setup({ repo: TWO_HUNK_EDIT });
		await app.repo.open();
		await app.staging.open();

		await app.staging.openFile(FILE);

		const headers = await waitFor("the file's hunks", () => {
			const showing = app.staging.hunkHeaders();
			return showing.length > 0 ? showing : null;
		});
		expect(headers).toEqual([
			"@@ -1,6 +1,6 @@",
			"@@ -17,6 +17,9 @@ line 16",
		]);
	});
});

function fileOf(rows: string[]): string {
	return `${rows.join("\n")}\n`;
}
