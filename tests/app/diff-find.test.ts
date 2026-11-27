import { afterEach, describe, expect, it } from "vitest";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

describe("find in a diff", () => {
	afterEach(teardown);

	it("finds the passage being read while the commit's diff stays open", async () => {
		const app = await setup({
			repo: {
				steps: [
					{ step: "file", path: "notes.txt", content: "value in the diff\n" },
					{
						step: "commit",
						message: "Change notes\n\nWhy this change matters",
					},
				],
			},
		});
		await app.repo.open();
		await app.repo.selectCommit("Change notes");
		await app.repo.openCommitFile("notes.txt");
		await waitFor(
			"the committed diff",
			() => app.diffPane.selectedPath() === "notes.txt" || null,
		);
		await app.events.searchToggle();
		await app.search.query("value");
		await waitFor(
			"the highlighted code",
			() => app.diffPane.markedLine() === "value in the diff" || null,
		);
		await app.repo.readCommitBody();
		await app.events.searchToggle();
		await app.search.query("this change");
		await expect(
			waitFor("the exact marked passage", () => app.repo.markedPassage()),
		).resolves.toBe("this change");
		await app.search.escapeFromNavigation();
		await app.settled();
		expect(app.repo.markedPassage()).toBeNull();
		expect(app.diffPane.markedLine()).toBe("value in the diff");
		expect(app.diffPane.selectedPath()).toBe("notes.txt");
	});

	it("searches the open working-tree diff from the native Find command", async () => {
		const added = Array.from(
			{ length: 400 },
			(_, line) => `added line ${line}`,
		).join("\n");
		const app = await setup({
			viewportHeight: 240,
			repo: {
				steps: [
					{ step: "file", path: "notes.txt", content: "old needle\n" },
					{ step: "commit", message: "base" },
					{
						step: "file",
						path: "notes.txt",
						content: `${added}\nnew needle\n`,
					},
				],
			},
		});
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("notes.txt");
		await waitFor(
			"the working-tree diff",
			() => app.staging.addedLines().includes("added line 0") || null,
		);

		expect(app.staging.addedLines()).not.toContain("new needle");
		await app.events.searchToggle();
		await app.search.query("NEEDLE");

		await expect(
			waitFor("the diff match count", () => app.search.matchCount()),
		).resolves.toBe("1 of 2");
		await expect(
			waitFor("the marked deletion", () => app.diffPane.markedLine()),
		).resolves.toBe("old needle");
		await app.search.step(true);
		await waitFor(
			"the offscreen addition after backward wrap",
			() => app.diffPane.markedLine() === "new needle" || null,
		);
		expect(app.search.matchCount()).toBe("2 of 2");

		await app.search.step();
		await waitFor(
			"the deletion after forward wrap",
			() => app.diffPane.markedLine() === "old needle" || null,
		);
		expect(app.search.matchCount()).toBe("1 of 2");
	});
});
