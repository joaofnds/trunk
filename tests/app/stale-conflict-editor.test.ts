import { afterEach, describe, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** A clone that has moved on from its remote in the same file, so a pull with
 *  rebase stops on a conflict: the shape from the recording that raised this. */
const DIVERGED_IN_ONE_FILE: RepoSpec = {
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
			path: "shared.txt",
			content: "theirs",
			message: "Theirs",
		},
		{ step: "file", path: "shared.txt", content: "mine" },
		{ step: "commit", message: "Mine" },
	],
};

describe("a pull that stops on a conflict", () => {
	afterEach(teardown);

	it("takes the conflict editor and the failure notice away when the rebase is aborted", async () => {
		const app = await setup({ repo: DIVERGED_IN_ONE_FILE });
		await app.repo.open();

		await app.remote.pullRebase();
		await waitFor("the pull failure notice", () => app.remote.message());

		// The failed pull leaves a rebase in progress that only the filesystem
		// tells the app about; the watcher is off here, so the harness makes the
		// same emit it would have.
		await app.events.externalChange(app.repo.path);
		await waitFor("the rebase banner", () => app.staging.banner());

		await app.staging.openConflictedFile("shared.txt");
		await waitFor("the conflict editor", () =>
			app.mergeEditor.isShowing() ? true : null,
		);

		app.dialog.confirms();
		await app.staging.abortRebase();

		await app.elapseUntil("the conflict editor to close", () =>
			app.mergeEditor.isShowing() ? null : true,
		);
		await app.elapseUntil("the failure notice to go", () =>
			app.remote.message() === null ? true : null,
		);
	});

	it("closes the conflict editor when the rebase is aborted outside the app", async () => {
		const app = await setup({ repo: DIVERGED_IN_ONE_FILE });
		await app.repo.open();

		await app.remote.pullRebase();
		await waitFor("the pull failure notice", () => app.remote.message());
		await app.events.externalChange(app.repo.path);
		await waitFor("the rebase banner", () => app.staging.banner());

		await app.staging.openConflictedFile("shared.txt");
		await waitFor("the conflict editor", () =>
			app.mergeEditor.isShowing() ? true : null,
		);

		// Nobody touched the UI: this is the abort the user ran in a terminal,
		// which reaches the app only as a change on disk.
		await app.events.rebaseAbortedElsewhere(app.repo.path);

		await app.elapseUntil("the conflict editor to close", () =>
			app.mergeEditor.isShowing() ? null : true,
		);
	});
});
