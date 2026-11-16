import { afterEach, expect, it } from "vitest";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

afterEach(teardown);

it("settles interactions with a future release check still scheduled", async () => {
	const app = await setup();
	await waitFor("the release check timer", () =>
		app.scheduler.pending > 0 ? true : null,
	);

	await app.settled();

	expect(app.scheduler.pendingForeground).toBe(0);
	expect(app.scheduler.pending).toBe(1);
	expect(app.invokes().filter(({ cmd }) => cmd === "updates_check")).toEqual(
		[],
	);
});

it("completes a background release check through the offline application host", async () => {
	const app = await setup();
	await waitFor("the release check timer", () =>
		app.scheduler.pending > 0 ? true : null,
	);

	app.advanceBy(15_000);
	await waitFor("the background release check", () =>
		app.invokes().some(({ cmd }) => cmd === "updates_check") ? true : null,
	);
	await app.settled();

	expect(
		app.invokes().filter(({ cmd }) => cmd === "updates_check"),
	).toHaveLength(1);
	expect(app.scheduler.pending).toBe(1);
	expect(app.toasts()).toEqual([]);
	await expect(app.updateStatus()).resolves.toMatchObject({
		phase: "manual",
		version: null,
		message: "Trunk is up to date",
		eligible: false,
	});
});
