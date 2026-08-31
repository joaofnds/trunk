import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One committed file carrying an uncommitted edit: commenting on that edit is
 *  what anchors a thread to a working-tree snapshot. */
const EDITED: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one\ntwo\nthree\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "a.txt", content: "one\nEDITED\nthree\n" },
	],
};

describe("a comment on uncommitted work", () => {
	afterEach(teardown);

	it("keeps its anchor commit through git gc", async () => {
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

		const pinned = () =>
			execFileSync("git", ["show-ref"], {
				cwd: app.repo.path,
				encoding: "utf8",
			})
				.split("\n")
				.filter((l) => l.includes("review-snapshots"))
				.map((l) => l.split(" ")[0]);

		const anchors = await waitFor("the snapshot pin", () => {
			const refs = pinned();
			return refs.length > 0 ? refs : null;
		});
		expect(anchors).toHaveLength(1);
		const anchor = anchors[0];

		// The claim the whole design rests on: gc must not collect it.
		execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], {
			cwd: app.repo.path,
		});
		execFileSync("git", ["gc", "--prune=now", "--aggressive"], {
			cwd: app.repo.path,
		});

		const stillThere = execFileSync("git", ["cat-file", "-t", anchor], {
			cwd: app.repo.path,
			encoding: "utf8",
		}).trim();
		expect(stillThere).toBe("commit");
	});
});
