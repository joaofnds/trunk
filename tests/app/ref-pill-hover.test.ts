import { tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One commit that two branches point at, so its pill folds `topic` into a
 *  `+1` badge. */
const TWO_REFS_ON_ONE_COMMIT: RepoSpec = {
	steps: [
		{ step: "file", path: "base.txt", content: "base" },
		{ step: "commit", message: "Base" },
		{ step: "branch", name: "topic" },
	],
};

async function openWithPill() {
	const app = await setup({ repo: TWO_REFS_ON_ONE_COMMIT });
	await app.repo.open();
	await waitFor("the main pill", () =>
		app.repo.refPills().includes("main") ? true : null,
	);

	return app;
}

describe("ref pills", () => {
	afterEach(teardown);

	it("lists every ref of the commit under a hovered overflow badge", async () => {
		const app = await openWithPill();

		await app.repo.hoverOverflowBadge("main");

		expect(app.repo.hoveredRefs()).toEqual(["main", "topic"]);
	});

	it("lists every ref of the commit under a hovered pill", async () => {
		const app = await openWithPill();

		await app.repo.hoverRefPill("main");
		await tick();

		expect(app.repo.hoveredRefs()).toEqual(["main", "topic"]);
	});

	it("keeps the list open while the pointer moves from the badge into it", async () => {
		const app = await openWithPill();
		await app.repo.hoverOverflowBadge("main");

		app.repo.leaveOverflowBadge("main");
		app.repo.enterHoveredRefs();
		app.advanceBy(50);
		await tick();

		expect(app.repo.hoveredRefs()).toEqual(["main", "topic"]);
	});

	it("closes the list 50ms after the pointer leaves the badge for elsewhere", async () => {
		const app = await openWithPill();
		await app.repo.hoverOverflowBadge("main");

		app.repo.leaveOverflowBadge("main");
		app.advanceBy(49);
		await tick();
		expect(app.repo.hoveredRefs()).toEqual(["main", "topic"]);

		app.advanceBy(1);
		await tick();
		expect(app.repo.hoveredRefs()).toBeNull();
	});

	it("leaves keyboard focus on the commit list when a pill is pressed", async () => {
		const app = await openWithPill();

		await app.repo.pressRefPill("main");

		expect(app.repo.commitListHasFocus()).toBe(true);
	});

	it("leaves keyboard focus on the commit list when a listed ref is pressed", async () => {
		const app = await openWithPill();
		await app.repo.hoverOverflowBadge("main");

		app.repo.pressHoveredRef("topic");

		expect(app.repo.commitListHasFocus()).toBe(true);
	});

	it("opens the ref's menu on a right click of its pill", async () => {
		const app = await openWithPill();

		await app.repo.openRefPillMenu("main");

		expect(app.contextMenu.items().map((item) => item.label)).toEqual([
			"Rename…",
			"Delete",
		]);
	});
});
