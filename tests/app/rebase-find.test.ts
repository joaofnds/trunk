import { afterEach, expect, it } from "vitest";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

afterEach(teardown);

it("finds a commit in the rebase plan without changing its order", async () => {
	const app = await setup({
		repo: {
			steps: [
				{ step: "commit", message: "base" },
				{ step: "commit", message: "fix parser" },
				{ step: "commit", message: "fix lexer" },
				{ step: "commit", message: "update docs" },
			],
		},
	});
	await app.repo.open();
	await app.repo.contextMenu("fix parser");
	app.contextMenu.choose("Interactive Rebase...");
	const plan = await app.rebaseEditor.rows();

	await app.events.searchToggle();
	await app.search.query("FIX");
	await expect(
		waitFor("matching plan entries", () => app.search.matchCount()),
	).resolves.toBe("1 of 2");
	await app.search.step();
	await app.search.escapeFromNavigation();

	await expect(
		waitFor("keyboard focus on the matched commit", () =>
			app.rebaseEditor.focusedRow(),
		),
	).resolves.toBe("fix parser");
	expect(await app.rebaseEditor.rows()).toEqual(plan);
});
