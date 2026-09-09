import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const UNTOUCHED = "src/untouched.ts";

/** One committed file no pending change touches, which is the file a
 *  current-file comment exists to reach: no diff shows it, so before the finder
 *  there was nowhere for a comment about it to live. */
const ONE_UNTOUCHED_FILE: RepoSpec = {
	steps: [
		{
			step: "file",
			path: UNTOUCHED,
			content: "const answer = 42;\nexport { answer };\n",
		},
		{ step: "file", path: "other.txt", content: "unrelated\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "other.txt", content: "edited\n" },
	],
};

/** Opens the untouched file through the finder and leaves the pane on it. */
async function openTheUntouchedFile(app: Awaited<ReturnType<typeof setup>>) {
	await app.repo.open();
	await app.review.openPanel();
	await app.review.openFileFinder();
	await app.review.findFile("untouched");
	await waitFor("the narrowed list", () =>
		app.review.finderRows().length === 1 ? true : null,
	);
	await app.review.openTopFinderRow();
	await waitFor("the file's content in the pane", () => {
		const lines = app.diffPane.contextLines();
		return lines.length > 0 ? lines : null;
	});
}

describe("commenting on a file no pending change touches", () => {
	afterEach(teardown);

	it("pins the selected lines and the thread survives", async () => {
		const app = await setup({ repo: ONE_UNTOUCHED_FILE });
		await openTheUntouchedFile(app);

		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("this constant needs a name");
		await app.review.submit();
		await app.review.openPanel();

		const threads = await waitFor("the thread", () => {
			const listed = app.review.threads();
			return listed.length > 0 ? listed : null;
		});
		expect(threads[0]).toContain(UNTOUCHED);
		expect(app.review.orphanBadges()[0]).toBe("");
	});

	it("badges the thread once the pinned lines leave the file", async () => {
		const app = await setup({ repo: ONE_UNTOUCHED_FILE });
		await openTheUntouchedFile(app);
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("this constant needs a name");
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("the thread", () =>
			app.review.threads().length > 0 ? true : null,
		);

		writeFileSync(
			join(app.repo.path, UNTOUCHED),
			"const reply = 42;\nexport { reply };\n",
		);
		await app.events.externalChange(app.repo.path);

		await waitFor("the orphan badge the vanished code earns", () =>
			app.review.orphanBadges()[0] === "code gone" ? true : null,
		);
	});
});
