import { tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const WATCHED = "src/watched.ts";
const SETTLED = "const answer = 44;\nexport { answer };\n";

const ONE_TRACKED_FILE: RepoSpec = {
	steps: [
		{
			step: "file",
			path: WATCHED,
			content: "const answer = 42;\nexport { answer };\n",
		},
		{ step: "commit", message: "base" },
	],
};

function reads(app: Awaited<ReturnType<typeof setup>>): number {
	return app.invokes().filter(({ cmd }) => cmd === "open_current_file").length;
}

describe("a current-file read still in flight when more changes arrive", () => {
	afterEach(teardown);

	it("admits one read and one catch-up however many events arrive", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		const before = reads(app);
		const release = app.holdCommand("open_current_file");

		for (let index = 0; index < 8; index += 1) {
			app.repo.writeWorkingTreeFile(WATCHED, `const answer = ${index};\n`);
			await app.events.externalChange(app.repo.path);
			app.advanceBy(200);
			await tick();
		}
		expect(reads(app)).toBe(before + 1);

		app.repo.writeWorkingTreeFile(WATCHED, SETTLED);
		release();
		await app.settled();

		expect(reads(app)).toBe(before + 2);
		expect(app.diffPane.contextLines()).toEqual([
			"const answer = 44;",
			"export { answer };",
		]);
	});

	it("does not bring the pane back once the user has closed it", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		const before = reads(app);
		const release = app.holdCommand("open_current_file");
		app.repo.writeWorkingTreeFile(WATCHED, SETTLED);
		await app.events.externalChange(app.repo.path);
		await waitFor("the held refresh", () =>
			reads(app) > before ? true : null,
		);

		await app.diffPane.close();
		release();
		await app.settled();

		expect(app.diffPane.selectedPath()).toBeNull();
		expect(app.diffPane.contextLines()).toEqual([]);
	});
});
