import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/main.ts";
/** How either section writes a modified file: status badge, then path. */
const MODIFIED_ROW = `M ${FILE}`;

const NUMBERED = Array.from({ length: 24 }, (_, at) => `line ${at + 1}`);
const REWRITTEN = NUMBERED.with(2, "line 3 CHANGED");

const COMMITTED = fileOf(NUMBERED);
/** One line rewritten near the top and three inserted near the bottom: two
 *  hunks, the second of them pure insertions. */
const WORKING = fileOf(
	REWRITTEN.toSpliced(19, 0, "extra a", "extra b", "extra c"),
);
/** The committed file with the rewritten line and the one insertion the discard
 *  leaves behind — the whole of AC#2, as one string. */
const RESTORED = fileOf(REWRITTEN.toSpliced(19, 0, "extra c"));

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

	it("stages one hunk on its own, then restores exactly the lines discarded from the rest", async () => {
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

		await app.staging.stageHunk(0);
		await app.events.externalChange(app.repo.path);
		await app.settle();

		expect(app.staging.stagedFiles()).toEqual([MODIFIED_ROW]);
		expect(app.staging.unstagedFiles()).toEqual([MODIFIED_ROW]);
		expect(app.staging.hunkHeaders()).toEqual(["@@ -17,6 +17,9 @@ line 16"]);
		expect(app.staging.addedLines()).toEqual(["extra a", "extra b", "extra c"]);

		app.dialog.confirms();
		await app.staging.selectLines("extra a", "extra b");
		await app.staging.discardSelectedLines();

		await waitFor("the discarded lines to leave the pane", () =>
			app.staging.addedLines().length === 1 ? true : null,
		);
		expect(app.staging.addedLines()).toEqual(["extra c"]);
		expect(app.repo.workingTreeFile(FILE)).toEqual(RESTORED);
	});
});

function fileOf(rows: string[]): string {
	return `${rows.join("\n")}\n`;
}
