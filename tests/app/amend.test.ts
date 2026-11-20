import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";

const WRAPPED_MESSAGE = "line one\nline two\n\n  indented body\n";

const A_WRAPPED_COMMIT_AND_A_NEW_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a\n" },
		{ step: "commit", message: WRAPPED_MESSAGE },
		{ step: "file", path: "late.txt", content: "late\n" },
	],
};

function git(repoPath: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
}

describe("amend", () => {
	afterEach(teardown);

	it("folds the staged file into HEAD under its message as written", async () => {
		const app = await setup({ repo: A_WRAPPED_COMMIT_AND_A_NEW_FILE });
		await app.repo.open();
		const written = git(app.repo.path, "log", "-1", "--format=%B");
		const amended = git(app.repo.path, "rev-parse", "HEAD");
		await app.staging.open();
		await app.staging.stageEverything();

		await app.staging.amendKeepingMessage();

		await app.elapseUntil("HEAD to be replaced", () =>
			git(app.repo.path, "rev-parse", "HEAD") === amended ? null : true,
		);
		expect(git(app.repo.path, "log", "-1", "--format=%B")).toBe(written);
		expect(git(app.repo.path, "ls-tree", "--name-only", "HEAD")).toBe(
			"a.txt\nlate.txt\n",
		);
	});
});
