import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One committed file carrying an uncommitted edit: commenting on that edit is
 *  what anchors a thread to a working-tree snapshot, which is the only anchor
 *  that can go stale today. */
const EDITED: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one\ntwo\nthree\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "a.txt", content: "one\nEDITED\nthree\n" },
	],
};

describe("staleness on a comment about uncommitted work", () => {
	afterEach(teardown);

	it("recomputes when the repository changes under the app", async () => {
		const app = await setup({ repo: EDITED });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("a.txt");
		await waitFor("the unstaged diff", () => {
			const lines = app.staging.addedLines();
			return lines.length > 0 ? lines : null;
		});
		await app.review.showInlineComments();
		await app.review.commentOnHunk(0);
		await app.review.write("this line needs a look");
		await app.review.submit();
		await waitFor("the thread", () => {
			const threads = app.review.threads();
			return threads.length > 0 ? threads : null;
		});

		writeFileSync(join(app.repo.path, "a.txt"), "one\nREWRITTEN\nthree\n");
		await app.events.externalChange(app.repo.path);

		await waitFor("the staleness recompute", () =>
			app.invokes().some((i) => i.cmd === "refresh_thread_staleness")
				? true
				: null,
		);
	});
});
