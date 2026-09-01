import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/**
 * The application harness stubbed one height for every element, so the commit
 * list measured a row as tall as its whole viewport, one row filled it, and the
 * visible range never left 0 whatever viewport height a test asked for. Nothing
 * here could scroll, and a feature keyed on scroll position was unverifiable.
 *
 * This pins the harness's own contract: ask for a short viewport and the real
 * application virtualizes behind it.
 */
const COMMIT_COUNT = 60;

const MANY_COMMITS: RepoSpec = {
	steps: Array.from({ length: COMMIT_COUNT }, (_, i) => [
		{ step: "file" as const, path: `f${i}.txt`, content: `${i}` },
		{ step: "commit" as const, message: `commit ${i}` },
	]).flat(),
};

describe("the commit list behind a short viewport", () => {
	afterEach(teardown);

	it("renders fewer rows than the repository has commits", async () => {
		const app = await setup({ repo: MANY_COMMITS, viewportHeight: 200 });
		await app.repo.open();

		const rows = await waitFor("the commit rows", () => {
			const shown = app.repo.commitRows().length;
			return shown > 0 ? shown : null;
		});

		expect(rows).toBeLessThan(COMMIT_COUNT);
	});

	it("shows every commit when the viewport is tall enough to hold them", async () => {
		const app = await setup({ repo: MANY_COMMITS });
		await app.repo.open();

		await expect(
			waitFor("every commit row", () =>
				app.repo.commitRows().length === COMMIT_COUNT ? true : null,
			),
		).resolves.toBe(true);
	});
});
