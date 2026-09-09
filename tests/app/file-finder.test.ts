import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const UNTOUCHED = "src/untouched.ts";
const EDITED = "src/edited.ts";
const UNTRACKED = "src/scratch.ts";

const UNTOUCHED_BODY = "const answer = 42;\nexport { answer };\n";

/** One committed file left alone and one carrying an uncommitted edit: the
 *  finder's whole point is that the first is reachable and no diff shows it. */
const ONE_EDIT: RepoSpec = {
	steps: [
		{ step: "file", path: UNTOUCHED, content: UNTOUCHED_BODY },
		{ step: "file", path: EDITED, content: "let count = 0;\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: EDITED, content: "let count = 1;\n" },
		{ step: "file", path: UNTRACKED, content: "throwaway\n" },
	],
};

describe("reaching a file no pending change touches", () => {
	afterEach(teardown);

	it("opens its current content from the review panel's finder", async () => {
		const app = await setup({ repo: ONE_EDIT });
		await app.repo.open();
		await app.review.openPanel();

		await app.review.openFileFinder();

		const rows = await waitFor("the finder's rows", () => {
			const listed = app.review.finderRows();
			return listed.length > 0 ? listed : null;
		});
		expect(rows[0]).toBe(EDITED);
		expect(rows).toContain(UNTOUCHED);
		expect(rows).not.toContain(UNTRACKED);

		await app.review.findFile("untouched");
		await waitFor("the narrowed list", () =>
			app.review.finderRows().length === 1 ? true : null,
		);
		await app.review.openTopFinderRow();

		const shown = await waitFor("the file's content in the pane", () => {
			const lines = app.diffPane.contextLines();
			return lines.length > 0 ? lines : null;
		});
		expect(shown).toEqual(["const answer = 42;", "export { answer };"]);
	});

	it("offers no comment gesture until a line is selected", async () => {
		const app = await setup({ repo: ONE_EDIT });
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

		const commentButtons = [...document.querySelectorAll("button")].filter(
			(button) => /comment/i.test(button.textContent ?? ""),
		);
		expect(commentButtons).toEqual([]);
	});
});
