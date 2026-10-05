import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/main.ts";
const COMMITTED = ["line 1", "line 2", "line 3"];
const WORKING = [...COMMITTED, "extra a", "extra b", "extra c"];

const THREE_ADDED_LINES: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(COMMITTED) },
		{ step: "commit", message: "Add main" },
		{ step: "file", path: FILE, content: fileOf(WORKING) },
	],
};

describe("a drag down a diff's gutter", () => {
	afterEach(teardown);

	it("selects every line the pointer crosses with the button held", async () => {
		const app = await openDiff();

		await app.staging.dragLines("extra a", "extra b", "extra c");

		const offered = await waitFor("line actions on the selection", () =>
			app.staging.lineActions().length > 0 ? app.staging.lineActions() : null,
		);
		expect(offered).toEqual(["Discard Lines (3)", "Stage Lines (3)"]);
	});

	it("selects nothing more once the pointer moves with no button held", async () => {
		const app = await openDiff();
		await app.staging.dragLines("extra a");

		app.staging.hoverLine("extra c");

		await app.settled();
		expect(app.staging.lineActions()).toEqual([
			"Discard Lines (1)",
			"Stage Lines (1)",
		]);
	});
});

async function openDiff() {
	const app = await setup({ repo: THREE_ADDED_LINES });
	await app.repo.open();
	await app.staging.open();
	await app.staging.openFile(FILE);
	await waitFor("the file's hunk", () =>
		app.staging.addedLines().length === 3 ? true : null,
	);
	await app.settled();

	return app;
}

function fileOf(rows: string[]): string {
	return `${rows.join("\n")}\n`;
}
