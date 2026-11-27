import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

afterEach(teardown);

it("keeps the file open across keyboard history selection and commit paging", async () => {
	const app = await setup({
		viewportHeight: 600,
		repo: {
			steps: [
				{ step: "file", path: "one.txt", content: "before\n" },
				{ step: "commit", message: "first revision" },
				...Array.from({ length: 201 }, (_, i) => ({
					step: "commit" as const,
					message: `unrelated ${i}`,
				})),
				{ step: "file", path: "one.txt", content: "middle\n" },
				{ step: "commit", message: "middle revision" },
				{ step: "file", path: "one.txt", content: "after\n" },
				{ step: "commit", message: "latest revision" },
			],
		},
	});
	await app.repo.open();
	await app.repo.selectCommit("middle revision");
	await app.repo.openCommitFile("one.txt");
	await waitFor(
		"the middle revision's diff",
		() => app.staging.addedLines().includes("middle") || null,
	);

	await app.repo.openFileMenuWithKey("Shift+F10");
	app.contextMenu.choose("Show commits touching this path");
	await app.repo.pressKeyInPathHistory("j");
	await app.settled();
	expect(app.repo.selectedCommitSummary()).toBe("middle revision");
	await app.repo.pressKeyInPathHistory("k");
	await app.settled();
	expect(app.repo.selectedCommitSummary()).toBe("middle revision");
	await app.repo.chooseInPathHistory("middle revision");
	await app.settled();
	await app.repo.stepToNewerCommit();
	await waitFor(
		"the next revision's diff",
		() => app.staging.addedLines().includes("after") || null,
	);

	await app.repo.openFileMenuWithKey("ContextMenu");
	app.contextMenu.choose("Show commits touching this path");
	await app.repo.showOlderPathChanges();
	await app.repo.chooseInPathHistory("first revision");
	await waitFor(
		"the earlier revision's added line",
		() => app.staging.addedLines().includes("before") || null,
	);
	expect(app.diffPane.selectedPath()).toBe("one.txt");
	await expect(
		waitFor(
			"the newer commit in the pager",
			() => app.repo.canStepToNewerCommit() || null,
		),
	).resolves.toBe(true);
});

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function commit(repo: string, subject: string) {
	execFileSync("git", ["commit", "-qm", subject], { cwd: repo, env: gitEnv });
}

/** Insert a path into Git directly because the checkout filesystem may reject its bytes. */
function stagePath(repo: string, name: Buffer, text: string) {
	const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
		cwd: repo,
		env: gitEnv,
		input: text,
		encoding: "utf8",
	}).trim();
	execFileSync("git", ["update-index", "-z", "--index-info"], {
		cwd: repo,
		env: gitEnv,
		input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.of(0)]),
	});
}

it("opens the historical patch of a non-UTF-8 path alongside its replacement-character sibling", async () => {
	const app = await setup({ repo: { steps: [] } });
	const raw = Buffer.concat([Buffer.from([0x66, 0xff]), Buffer.from(".md")]);
	const sibling = Buffer.from("f�.md");
	stagePath(app.repo.path, raw, "original raw line\n");
	stagePath(app.repo.path, sibling, "sibling line\n");
	stagePath(app.repo.path, Buffer.from("f\\xff.md"), "literal byte escapes\n");
	commit(app.repo.path, "both names");
	stagePath(app.repo.path, sibling, "edited sibling\n");
	commit(app.repo.path, "sibling only");
	stagePath(app.repo.path, raw, "edited raw line\n");
	commit(app.repo.path, "raw only");

	await app.repo.open();
	await app.repo.selectCommit("raw only");
	await app.repo.commitFileContextMenu("f\\xff.md");
	app.contextMenu.choose("Show commits touching this path");
	expect(await app.repo.pathHistoryChanges()).toEqual([
		"raw only",
		"both names",
	]);
	await app.repo.chooseInPathHistory("both names");

	await expect(
		waitFor("the original raw line", () => app.staging.addedLines()[0] ?? null),
	).resolves.toBe("original raw line");
	expect(app.diffPane.selectedPath()).toBe("f\\xff.md");
	const lookalikes = app.repo
		.commitFiles()
		.filter((row) => row.includes("f\\xff.md"));
	expect(lookalikes).toHaveLength(2);
	expect(lookalikes.filter((row) => row.includes("Byte escapes"))).toHaveLength(
		1,
	);
	expect(app.diffPane.disabledActionReasons()).toContain(
		"Comments require a UTF-8 file path",
	);
	expect(app.diffPane.disabledActionReasons()).toContain(
		"Markdown previews require a UTF-8 file path",
	);
});
