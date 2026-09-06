import { afterEach, describe, expect, it } from "vitest";
import { firstMatching } from "./drivers/dom.js";
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

	// TRUNK-129: the toggle command already returns the re-laid-out first page, so the
	// graph takes it from there. A second walk, or a refs or stash re-list, is the latency
	// the user saw as a toggle that had not taken.
	it("re-lays out the graph from the toggle's own response, without walking again", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();
		await waitFor("the topic pill", () =>
			app.repo.refPills().includes("topic") ? true : null,
		);
		await app.settled();
		const issuedBefore = app.invokes().length;

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil("the topic commits to leave the graph", () =>
			app.repo.commitRows().join("\n").includes("Topic two") ? null : true,
		);
		await app.settled();

		const issued = app
			.invokes()
			.slice(issuedBefore)
			.map(({ cmd }) => cmd);
		expect(issued.filter((cmd) => cmd === "set_ref_visibility")).toHaveLength(
			1,
		);
		expect(issued).not.toContain("refresh_commit_graph");
		expect(issued).not.toContain("list_refs");
		expect(issued).not.toContain("list_stashes");
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

	// TRUNK-128: BranchSidebar's stored-visibility read and CommitGraph's first page
	// load are independent sibling mount effects with no ordering between them.
	// open_repo always builds its first graph against an empty backend visibility
	// (nothing is stored there for a path the backend has not seen before), so a
	// repository opened with a non-empty stored hidden set can paint that first,
	// unfiltered graph before BranchSidebar's async prefs read comes back and
	// pushes the real set. Unlike every other case in this file, this test must
	// catch that frame itself rather than only the state the app eventually
	// settles into -- holding the prefs read open is what makes the frame
	// observable at all.
	it("never paints the hidden branch's commits or pill while its stored visibility is still loading", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.seedPref("ref_visibility", {
			[app.repo.path]: { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] },
		});

		const release = app.holdPrefsGet("ref_visibility");
		// Click the recent entry directly, without RepoDriver.open()'s own wait for
		// commits to appear -- that wait would deadlock against the held gate,
		// since the fix this test pins means no commits appear until release().
		const entry = await waitFor(`the recent entry for ${app.repo.path}`, () =>
			firstMatching('[role="button"]', (text) => text.includes(app.repo.path)),
		);
		entry.click();

		// The gated read is recorded the instant BranchSidebar's mount effect issues
		// it, before this promise blocks -- so by the time it shows up here,
		// open_repo has resolved and every effect mounted.
		await waitFor("BranchSidebar's visibility read to be gated", () =>
			app
				.invokes()
				.some((i) => i.cmd === "prefs_get" && i.args.key === "ref_visibility")
				? true
				: null,
		);
		// CommitGraph's own first page request is a second, independent host round
		// trip. Give it every chance to be issued and to return before the
		// assertion below runs -- the fixed code never issues this call until
		// release(), so this deliberately either finds the unfiltered page or times
		// out; both are meaningful, and the assertion below is what actually
		// distinguishes them.
		await waitFor(
			"the graph's first page to paint",
			() => (app.repo.commitRows().length > 0 ? true : null),
			500,
		).catch(() => undefined);

		// The graph's first page has not painted while the stored hidden set is
		// still held back -- the exact frame the bug produced.
		expect(app.repo.commitRows().join("\n")).not.toContain("Topic two");
		expect(app.repo.refPills()).not.toContain("topic");

		release();
		await waitFor("the repository's commits", () =>
			app.repo.commitRows().length > 0 ? true : null,
		);
		await app.elapseUntil("the graph to settle", () =>
			app.repo.commitRows().join("\n").includes("Main one") ? true : null,
		);
		await app.settled();

		expect(app.repo.commitRows().join("\n")).not.toContain("Topic two");
		expect(app.repo.refPills()).not.toContain("topic");
	});
});
