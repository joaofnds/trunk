import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const ONE_DIRTY_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: "f.txt", content: "one\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "f.txt", content: "one\ntwo\n" },
	],
};

const WIP_ROW = "// WIP";
const STASH_ROW = "WIP on main";

describe("stash", () => {
	afterEach(teardown);

	it("clears the working tree into a graph stash and pops it back", async () => {
		const app = await setup({ repo: ONE_DIRTY_FILE });
		await app.repo.open();
		await waitFor("the working-tree row", () =>
			app.repo.commitRows().some((row) => row.includes(WIP_ROW)) ? true : null,
		);

		await app.toolbar.stash();

		await app.elapseUntil("the stash in the graph", () =>
			app.repo.commitRows().some((row) => row.includes(STASH_ROW))
				? true
				: null,
		);
		await waitFor("the working-tree row to go", () =>
			app.repo.commitRows().some((row) => row.includes(WIP_ROW)) ? null : true,
		);
		expect(app.repo.workingTreeFile("f.txt")).toBe("one\n");

		await app.toolbar.pop();

		await app.elapseUntil("the stash to leave the graph", () =>
			app.repo.commitRows().some((row) => row.includes(STASH_ROW))
				? null
				: true,
		);
		await waitFor("the working-tree row back", () =>
			app.repo.commitRows().some((row) => row.includes(WIP_ROW)) ? true : null,
		);
		expect(app.repo.workingTreeFile("f.txt")).toBe("one\ntwo\n");
	});
});
