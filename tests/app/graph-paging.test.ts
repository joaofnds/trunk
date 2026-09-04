import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";

/**
 * The graph pages history in as the user scrolls, and it used to stop after two
 * pages and never resume however far they scrolled on. The load-more effect had
 * gone dead: its guard returned on the re-entrancy latch before reading any
 * reactive state, so Svelte recorded no dependencies for that run and nothing
 * could ever invalidate it again (TRUNK-148).
 *
 * Only the assembled application reproduces it. Under a component test the page
 * resolves before the list appends, so the effect never enters with the latch
 * set and the dead state is never reached — a unit-level version of this test
 * passed on the unfixed code.
 */
const PAGE = 200;
const DEPTH = 2 * PAGE + 50;

/** Short enough that the list virtualizes, so scrolling is what reaches the end
 *  of the loaded rows rather than the whole history being on screen at once. */
const VIEWPORT_HEIGHT = 600;

const DEEP_HISTORY: RepoSpec = {
	steps: Array.from({ length: DEPTH }, (_, i) => [
		{ step: "file" as const, path: `f${i}.txt`, content: `${i}` },
		{ step: "commit" as const, message: `commit ${i}` },
	]).flat(),
};

describe("paging the commit graph by scrolling", () => {
	afterEach(teardown);

	it("reaches the initial commit in a history several pages deep", async () => {
		const app = await setup({
			repo: DEEP_HISTORY,
			viewportHeight: VIEWPORT_HEIGHT,
		});
		await app.repo.open();

		await app.scrollToOldest();

		expect(app.repo.loadedDepth()).toBe(DEPTH);
	}, 60_000);
});
