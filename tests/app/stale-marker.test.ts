import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One committed file carrying an uncommitted edit: commenting on that edit
 * anchors a thread to the working-tree snapshot this scenario moves away from
 * and back to. */
const EDITED: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one\ntwo\nthree\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "a.txt", content: "one\nEDITED\nthree\n" },
	],
};

describe("staleness on a comment about uncommitted work", () => {
	afterEach(teardown);

	it("shows and clears the marker as the anchored content changes", async () => {
		const app = await setup({ repo: EDITED });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("a.txt");
		await waitFor("the unstaged diff", () => {
			const lines = app.staging.addedLines();
			return lines.length > 0 ? lines : null;
		});
		await app.review.commentOnHunk(0);
		await app.review.write("this line needs a look");
		await app.review.submit();
		await waitFor("the fresh thread", () => {
			const threads = app.review.threads();
			return threads.length > 0 && app.review.staleMarkers()[0] === ""
				? threads
				: null;
		});

		writeFileSync(join(app.repo.path, "a.txt"), "one\nREWRITTEN\nthree\n");
		await app.events.externalChange(app.repo.path);

		await waitFor("the visible stale marker", () =>
			app.review.staleMarkers()[0] === "stale" ? true : null,
		);

		writeFileSync(join(app.repo.path, "a.txt"), "one\nEDITED\nthree\n");
		await app.events.externalChange(app.repo.path);

		await waitFor("the cleared stale marker", () =>
			app.review.staleMarkers()[0] === "" ? true : null,
		);
	});
});
