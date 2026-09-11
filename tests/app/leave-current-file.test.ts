import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const UNTOUCHED = "src/untouched.ts";
const EDITED = "src/edited.ts";
const MODE_BOUND_DIFF_COMMANDS = new Set([
	"diff_unstaged",
	"diff_staged",
	"diff_commit_file",
	"diff_compare_file",
]);

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

	it("keeps a current-file view full while changing the global mode without requesting a diff", async () => {
		const app = await setup({ repo: ONE_EDIT });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile(EDITED);
		await app.diffPane.showFullFile();
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
		const diffRequests = app
			.invokes()
			.filter(({ cmd }) => MODE_BOUND_DIFF_COMMANDS.has(cmd));
		const hunkWrites = app
			.invokes()
			.filter(
				({ cmd, args }) =>
					cmd === "prefs_set" &&
					args.key === "diff_content_mode" &&
					args.value === "hunk",
			).length;

		await app.diffPane.showHunks();
		await waitFor("the hunk preference write", () =>
			app
				.invokes()
				.filter(
					({ cmd, args }) =>
						cmd === "prefs_set" &&
						args.key === "diff_content_mode" &&
						args.value === "hunk",
				).length > hunkWrites
				? true
				: null,
		);

		expect(app.diffPane.contextLines()).toContain("const answer = 42;");
		expect(
			app.invokes().filter(({ cmd }) => MODE_BOUND_DIFF_COMMANDS.has(cmd)),
		).toEqual(diffRequests);
	});

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

	it("withholds cached staging hunks after leaving a current-file view", async () => {
		const app = await setup({ repo: ONE_EDIT });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile(EDITED);
		await waitFor("the initial staging diff", () =>
			app.staging.addedLines().length > 0 ? true : null,
		);
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
		await app.diffPane.showFullFile();
		const requestCount = app
			.invokes()
			.filter(({ cmd }) => cmd === "diff_unstaged").length;
		const release = app.holdCommand("diff_unstaged");

		await app.staging.openFile(EDITED);
		await waitFor("the held staging request", () =>
			app.invokes().filter(({ cmd }) => cmd === "diff_unstaged").length >
			requestCount
				? true
				: null,
		);

		expect(app.diffPane.isLoading()).toBe(true);
		expect(app.staging.addedLines()).toEqual([]);
		release();
	});
});
