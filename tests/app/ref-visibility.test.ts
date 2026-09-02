import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/**
 * A branch carrying two commits `main` does not reach, so hiding it has something to take
 * out of the graph beyond its own pill.
 */
const DIVERGED: RepoSpec = {
	steps: [
		{ step: "file", path: "base.txt", content: "base" },
		{ step: "commit", message: "Base" },
		{ step: "branch", name: "topic" },
		{ step: "checkout", name: "topic" },
		{ step: "file", path: "t1.txt", content: "1" },
		{ step: "commit", message: "Topic one" },
		{ step: "file", path: "t2.txt", content: "2" },
		{ step: "commit", message: "Topic two" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "m1.txt", content: "m" },
		{ step: "commit", message: "Main one" },
	],
};

describe("ref visibility", () => {
	afterEach(teardown);

	// Acceptance #1, #3 and #4: hiding a ref takes its pill and every commit only it
	// reaches, and leaves what a visible ref still reaches alone.
	it("hides a branch's pill and the commits only it reached", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await waitFor("the topic pill", () =>
			app.repo.refPills().includes("topic") ? true : null,
		);
		expect(app.repo.commitRows().join("\n")).toContain("Topic two");

		await app.branches.toggleVisibility("topic");

		await app.elapseUntil("the topic commits to leave the graph", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? null : true,
		);

		const rows = app.repo.commitRows().join("\n");
		expect(rows).not.toContain("Topic one");
		expect(app.repo.refPills()).not.toContain("topic");
		// What main still reaches is untouched.
		expect(rows).toContain("Main one");
		expect(rows).toContain("Base");
		expect(app.repo.refPills()).toContain("main");
	});

	// Acceptance #6: a hidden ref stays listed, marked hidden, so it can be turned back on.
	it("keeps a hidden branch listed and marked", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("topic to read as hidden", () =>
			app.branches.isHidden("topic") ? true : null,
		);

		expect(app.branches.lists("topic")).toBe(true);
	});

	it("shows a hidden branch again, restoring its commits", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("the topic commits to leave", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? null : true,
		);

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("the topic commits to come back", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? true : null,
		);

		expect(app.repo.refPills()).toContain("topic");
	});

	// Acceptance #5: HEAD's branch offers no toggle and survives its section being hidden.
	it("offers no toggle on HEAD's branch and keeps it visible", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await waitFor("the sidebar to list both branches", () =>
			app.branches.lists("topic") && app.branches.lists("main") ? true : null,
		);
		expect(app.branches.offersVisibilityToggle("main")).toBe(false);
		expect(app.branches.offersVisibilityToggle("topic")).toBe(true);

		await app.branches.toggleSectionVisibility("Local");

		await app.elapseUntil("topic to read as hidden", () =>
			app.branches.isHidden("topic") ? true : null,
		);
		// Column 0, the WIP row and the head-lane extension all assume HEAD's tip is in
		// the walk, so its pill stays whatever the section says.
		expect(app.branches.isHidden("main")).toBe(false);
		expect(app.repo.refPills()).toContain("main");
	});

	// Acceptance #2: the hidden set survives a graph rebuild. Creating a branch is one of
	// the twenty-nine sites that refills the cache, and it must not resurrect what was hid.
	it("keeps the hidden set across a graph rebuild", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("the topic commits to leave", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? null : true,
		);

		await app.branches.create("another");
		await app.elapseUntil("the new branch's pill", () =>
			app.repo.refPills().includes("another") ? true : null,
		);
		await app.settled();

		expect(app.repo.commitRows().join("\n")).not.toContain("Topic two");
		expect(app.repo.refPills()).not.toContain("topic");
	});

	// Acceptance #7: closing and reopening the repository restores the same hidden set,
	// which is what the per-repo entry in trunk-prefs.json is for.
	it("restores the hidden set when the repository is reopened", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("the topic commits to leave", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? null : true,
		);
		await app.settled();

		await app.repo.close();
		await app.repo.open();

		await app.elapseUntil("the graph to come back", () =>
			app.repo.commitRows().join("\n").includes("Main one") ? true : null,
		);
		await app.settled();

		expect(app.repo.commitRows().join("\n")).not.toContain("Topic two");
		expect(app.repo.refPills()).not.toContain("topic");
		expect(app.branches.isHidden("topic")).toBe(true);
	});
});
