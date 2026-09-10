import { tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const REPO = {
	steps: [
		{ step: "commit" as const, message: "First" },
		{ step: "file" as const, path: "a.txt", content: "clean\n" },
		{ step: "commit" as const, message: "Add a" },
	],
};

describe("repository changes during a sustained event stream", () => {
	afterEach(teardown);

	function calls(
		app: Awaited<ReturnType<typeof setup>>,
		command: string,
	): number {
		return app.invokes().filter(({ cmd }) => cmd === command).length;
	}

	it("refreshes at the first deadline while changes continue", async () => {
		const app = await setup({ repo: REPO });
		await app.repo.open();
		await app.settled();
		const before = app.refreshes();

		app.repo.writeWorkingTreeFile("a.txt", "changed\n");
		await app.events.externalChange(app.repo.path);
		app.advanceBy(150);
		await app.events.externalChange(app.repo.path);
		app.advanceBy(49);
		expect(app.refreshes()).toBe(before);

		app.advanceBy(1);
		await tick();
		expect(app.refreshes()).toBe(before + 1);

		await app.elapseUntil("the working tree row", () =>
			app.repo.commitRows().some((row) => row.includes("// WIP")) ? true : null,
		);
	});

	it("admits one graph refresh and one catch-up while the graph is busy", async () => {
		const app = await setup({ repo: REPO });
		await app.repo.open();
		await app.settled();
		const before = calls(app, "refresh_commit_graph");
		const release = app.holdCommand("refresh_commit_graph");

		await app.events.externalChange(app.repo.path);
		app.advanceBy(200);
		await tick();
		for (let index = 0; index < 8; index += 1) {
			await app.events.externalChange(app.repo.path);
			app.advanceBy(200);
			await tick();
		}

		expect(calls(app, "refresh_commit_graph")).toBe(before + 1);
		release();
		await app.settled();
		expect(calls(app, "refresh_commit_graph")).toBe(before + 2);
	});

	it("bounds status scans while a status read is busy", async () => {
		const app = await setup({ repo: REPO });
		await app.repo.open();
		await app.settled();
		const before = calls(app, "get_status");
		const graphBefore = calls(app, "refresh_commit_graph");
		const release = app.holdCommand("get_status");

		await app.events.externalChange(app.repo.path);
		app.advanceBy(200);
		await tick();
		for (let index = 0; index < 8; index += 1) {
			await app.events.externalChange(app.repo.path);
			app.advanceBy(200);
			await tick();
		}

		expect(calls(app, "get_status")).toBe(before + 1);
		expect(calls(app, "refresh_commit_graph")).toBeGreaterThan(graphBefore);
		app.repo.writeWorkingTreeFile("final.txt", "final state\n");
		await app.events.externalChange(app.repo.path);
		release();
		await app.settled();
		expect(calls(app, "get_status")).toBe(before + 2);
		await app.staging.open();
		expect(app.staging.unstagedFiles()).toContainEqual(
			expect.stringContaining("final.txt"),
		);
	});

	it("admits a post-action status read after an older read settles", async () => {
		const app = await setup({ repo: REPO });
		await app.repo.open();
		await app.settled();
		app.repo.writeWorkingTreeFile("a.txt", "changed\n");
		await app.events.externalChange(app.repo.path);
		await app.settled();
		await app.staging.open();
		const beforeStatus = calls(app, "get_status");
		const beforeStage = calls(app, "stage_file");
		const release = app.holdCommand("get_status");

		await app.events.externalChange(app.repo.path);
		app.advanceBy(200);
		await tick();
		expect(calls(app, "get_status")).toBe(beforeStatus + 1);

		const action = app.staging.stageFile("a.txt");
		await waitFor("the stage command", () =>
			calls(app, "stage_file") === beforeStage + 1 ? true : null,
		);
		await waitFor("the optimistic staged row", () =>
			app.staging.stagedFiles().some((file) => file.includes("a.txt"))
				? true
				: null,
		);

		release();
		await waitFor("the catch-up status timer", () =>
			app.scheduler.pending > 0 ? true : null,
		);
		expect(calls(app, "get_status")).toBe(beforeStatus + 1);

		app.advanceBy(199);
		expect(calls(app, "get_status")).toBe(beforeStatus + 1);
		app.advanceBy(1);
		await action;
		await waitFor("the post-action status read", () =>
			calls(app, "get_status") === beforeStatus + 2 ? true : null,
		);
		expect(app.staging.stagedFiles()).toContainEqual(
			expect.stringContaining("a.txt"),
		);
	});

	it("bounds both dirty-count owners while their reads are busy", async () => {
		const app = await setup({ repo: REPO });
		await app.repo.open();
		await app.settled();
		const before = calls(app, "get_dirty_counts");
		const release = app.holdCommand("get_dirty_counts");

		await app.events.externalChange(app.repo.path);
		app.advanceBy(200);
		await tick();
		for (let index = 0; index < 8; index += 1) {
			await app.events.externalChange(app.repo.path);
			app.advanceBy(200);
			await tick();
		}

		expect(calls(app, "get_dirty_counts")).toBe(before + 2);
		app.repo.writeWorkingTreeFile("dirty.txt", "final state\n");
		await app.events.externalChange(app.repo.path);
		release();
		await app.settled();
		expect(calls(app, "get_dirty_counts")).toBe(before + 4);
		expect(document.querySelector(".dirty-dot")).not.toBeNull();
	});
});
