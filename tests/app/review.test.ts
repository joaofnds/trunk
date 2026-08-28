import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/main.ts";
/** How the panel writes an anchored thread's file reference. */
const ANCHOR = `${FILE}:L3-L3`;
const COMMENT = "this line needs a look";

const NUMBERED = Array.from({ length: 24 }, (_, at) => `line ${at + 1}`);

/** One line rewritten near the top: a single hunk, so commenting the hunk with
 *  no line selection is unambiguous. */
const TWO_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(NUMBERED) },
		{ step: "commit", message: "Add main" },
		{
			step: "file",
			path: FILE,
			content: fileOf(NUMBERED.with(2, "line 3 CHANGED")),
		},
		{ step: "commit", message: "Change main" },
	],
};

describe("a comment left on a commit's diff", () => {
	afterEach(teardown);

	it("becomes a thread the panel keeps through publishing and marking it done", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await app.repo.open();
		await app.repo.selectCommit("Change main");
		await app.review.showInlineComments();
		await app.repo.openCommitFile(FILE);

		await app.review.commentOnHunk(0);
		await app.review.write(COMMENT);
		await app.review.submit();
		await app.review.openPanel();

		const threads = await waitFor("the review panel's threads", () => {
			const showing = app.review.threads();
			return showing.length > 0 ? showing : null;
		});
		expect(threads).toEqual([ANCHOR]);
		expect(app.review.states()).toEqual(["open"]);

		await app.review.publish();

		const published = await waitFor(
			"the actions a published thread offers",
			() => {
				const offered = app.review.actions();
				return offered.length > 0 && !offered.includes("Delete")
					? offered
					: null;
			},
		);
		expect(published).toEqual(["Mark done", "Dismiss", "Edit"]);
		expect(app.review.threads()).toEqual([ANCHOR]);
		expect(app.review.states()).toEqual(["open"]);

		await app.review.markDone();

		await waitFor("the thread to reach done", () =>
			app.review.states()[0] === "done" ? true : null,
		);
		expect(app.review.states()).toEqual(["done"]);
	});
});

function fileOf(rows: string[]): string {
	return `${rows.join("\n")}\n`;
}
