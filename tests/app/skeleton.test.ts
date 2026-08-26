import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
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

		const copying = invoke("plugin:clipboard-manager|write_text", {
			text: "abc",
		});

		await expect(copying).rejects.toThrow(
			"plugin:clipboard-manager|write_text",
		);
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

		const rows = await waitFor("the refreshed graph", () => {
			const rows = app.repo.commitRows();
			return rows.length > COMMIT_COUNT ? rows : null;
		});
		expect(rows[0]).toBe(`${WIP_PLACEHOLDER} A 1`);
	});

	it("holds no filesystem watch", async () => {
		const app = await setup({ repo: FOUR_COMMITS });

		await app.repo.open();

		await expect(app.events.watchers()).resolves.toBe(0);
	});
});
