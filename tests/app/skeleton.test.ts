import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const COMMIT_COUNT = 4;

/** What the graph's working-tree row reads with no commit draft typed. */
const WIP_PLACEHOLDER = "// WIP";

const FOUR_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a" },
		{ step: "commit", message: "First" },
		{ step: "file", path: "b.txt", content: "b" },
		{ step: "commit", message: "Second" },
		{ step: "file", path: "c.txt", content: "c" },
		{ step: "commit", message: "Third" },
		{ step: "file", path: "d.txt", content: "d" },
		{ step: "commit", message: "Fourth" },
	],
};

/** Two branches whose `a.txt` differ, so checking one out over an uncommitted
 *  edit of that file is the `dirty_workdir` refusal. */
const DIVERGED_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one" },
		{ step: "commit", message: "First" },
		{ step: "branch", name: "other" },
		{ step: "checkout", name: "other" },
		{ step: "file", path: "a.txt", content: "two" },
		{ step: "commit", message: "Second" },
		{ step: "checkout", name: "main" },
	],
};

const ONE_COMMIT: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one" },
		{ step: "commit", message: "First" },
	],
};

describe("the application", () => {
	afterEach(teardown);

	it("shows the commits of the repository the user opens", async () => {
		const app = await setup({ repo: FOUR_COMMITS });

		await app.repo.open();

		expect(app.repo.commitRows()).toEqual([
			"Fourth",
			"Third",
			"Second",
			"First",
		]);
	});

	it("rejects a command no route answers, naming it", async () => {
		await setup({ repo: FOUR_COMMITS });

		const notifying = invoke("plugin:notification|notify", { title: "hi" });

		await expect(notifying).rejects.toThrow("plugin:notification|notify");
	});

	it("reports the window state a test seeded through the driver", async () => {
		const app = await setup({ repo: FOUR_COMMITS });

		app.window.enterFullscreen();

		await expect(getCurrentWindow().isFullscreen()).resolves.toBe(true);
	});

	it("returns a reset Fake to its default answer", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		app.window.enterFullscreen();

		app.window.reset();

		await expect(getCurrentWindow().isFullscreen()).resolves.toBe(false);
	});

	it("shows a file added outside the app once an external change arrives", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();

		writeFileSync(join(app.repo.path, "e.txt"), "e");
		await app.events.externalChange(app.repo.path);

		const rows = await app.elapseUntil("the refreshed graph", () => {
			const rows = app.repo.commitRows();
			return rows.length > COMMIT_COUNT ? rows : null;
		});
		expect(rows[0]).toBe(`${WIP_PLACEHOLDER} A 1`);
	});

	it("turns a failing command's error code into the interface's own words", async () => {
		const app = await setup({ repo: DIVERGED_FILE });
		await app.repo.open();
		writeFileSync(join(app.repo.path, "a.txt"), "uncommitted");

		await app.branches.checkout("other");

		await expect(
			waitFor("the checkout refusal", () => app.branches.refusal("other")),
		).resolves.toBe(
			"Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.",
		);
	});

	it("shows a commit made in the app as the graph's newest row", async () => {
		const app = await setup({ repo: ONE_COMMIT });
		await app.repo.open();
		writeFileSync(join(app.repo.path, "b.txt"), "b");
		await app.events.externalChange(app.repo.path);
		await app.elapse();
		await app.staging.open();
		await app.staging.stageEverything();

		await app.staging.commit("Add b");

		await expect(
			app.elapseUntil("the new commit", () => {
				const rows = app.repo.commitRows();
				return rows.includes("Add b") ? rows : null;
			}),
		).resolves.toEqual(["Add b", "First"]);
	});

	it("ignores a change to a repository it does not have open", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();
		const before = app.refreshes();

		await app.events.externalChange("/somewhere/else");

		expect(app.scheduler.pending).toBe(0);
		app.scheduler.flush();
		expect(app.refreshes()).toBe(before);
	});

	it("reaches a listener whose registration is still in flight", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();
		let heard: string | undefined;
		const registering = listen<string>("repo-changed", (event) => {
			heard = event.payload;
		});

		await app.events.externalChange(app.repo.path);

		await registering;
		expect(heard).toBe(app.repo.path);
	});

	it("holds no filesystem watch", async () => {
		const app = await setup({ repo: FOUR_COMMITS });

		await app.repo.open();

		await expect(app.events.watchers()).resolves.toBe(0);
	});
});
