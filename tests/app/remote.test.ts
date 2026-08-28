import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** A clone whose remote moved on: `origin` carries a commit `main` has never
 *  seen, and `main` carries one the remote has never seen. */
const DIVERGED: RepoSpec = {
	steps: [
		{ step: "file", path: "shared.txt", content: "one" },
		{ step: "commit", message: "Shared" },
		{ step: "remote", name: "origin" },
		{ step: "trackUpstream", remote: "origin", branch: "main" },
		{ step: "push", remote: "origin", branch: "main" },
		{
			step: "remoteCommit",
			remote: "origin",
			branch: "main",
			path: "theirs.txt",
			content: "theirs",
			message: "Theirs",
		},
		{ step: "file", path: "mine.txt", content: "mine" },
		{ step: "commit", message: "Mine" },
	],
};

describe("a push to a remote that has moved", () => {
	afterEach(teardown);

	it("is refused with recovery on offer, and lands level once the user pulls", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();

		expect(app.repo.refPills()).toEqual(["main", "origin/main"]);

		await app.remote.push();

		const refusal = await waitFor("the push recovery prompt", () =>
			app.remote.recovery(),
		);
		expect(refusal).toEqual({
			text: "Push to origin rejected — main has diverged from the remote.",
			actions: ["Force Push", "Cancel"],
		});

		await app.remote.pullRebase();
		await app.remote.push();

		const pills = await waitFor("the graph to settle on one pill", () => {
			const showing = app.repo.refPills();
			return showing.length === 1 ? showing : null;
		});
		expect(pills).toEqual(["main"]);
	});
});
