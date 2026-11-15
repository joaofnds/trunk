import { fireEvent, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import type { UpdateStatus } from "./lib/updates.js";

let app: StartupHarness;
afterEach(() => app?.teardown());

const manual: UpdateStatus = {
	phase: "manual",
	current_version: "1.0.0",
	version: null,
	notes: null,
	message: null,
	downloaded: 0,
	total: null,
	eligible: false,
	adopted: false,
};
function startup() {
	app = new StartupHarness(
		[{ id: "active", repoPath: "/active", repoName: "active" }],
		"active",
	);
	app.host.seedResponse("updates_status", manual);
	app.host.seedResponse("updates_ready", manual);
	return app;
}

describe("App update readiness", () => {
	it("surfaces an initial status failure and retries only on request", async () => {
		startup();
		const status = app.host.holdNextReply("updates_status");
		app.start();
		await status.entered;

		status.reject({
			code: "update_error",
			message: "Could not read update state",
		});
		await app.settle();

		expect(screen.queryByRole("alert")).toHaveTextContent(
			"Could not read update state",
		);
		expect(app.host.count("updates_status")).toBe(1);
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: "Retry update status" }),
		);
		await app.settle();
		expect(app.host.count("updates_status")).toBe(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});
	it("retries failed readiness explicitly while retaining the manual recovery route", async () => {
		startup();
		app.host.seedResponse("updates_status", { ...manual, phase: "recovery" });
		const readiness = app.host.holdNextReply("updates_ready");
		app.start();
		await readiness.entered;

		readiness.reject({
			code: "update_error",
			message: "Could not save readiness",
		});
		await app.settle();

		expect(screen.queryByRole("alert")).toHaveTextContent(
			"Could not save readiness",
		);
		expect(app.host.count("updates_ready")).toBe(1);
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: "Retry startup verification" }),
		);
		await app.settle();
		expect(app.host.count("updates_ready")).toBe(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
	});
	it("keeps manual recovery and retry available when startup verification is still blocked", async () => {
		startup();
		app.host.seedResponse("updates_status", { ...manual, phase: "recovery" });
		const initial = app.host.holdNextReply("updates_ready");
		app.start();
		await initial.entered;
		initial.reject({
			code: "update_error",
			message: "Stored data needs recovery",
		});
		await app.settle();
		const retry = app.host.holdNextReply("updates_ready");

		await fireEvent.click(
			screen.getByRole("button", { name: "Retry startup verification" }),
		);
		await retry.entered;
		retry.reject({
			code: "update_error",
			message: "Stored data still needs recovery",
		});
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(2);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Stored data still needs recovery",
		);
		expect(
			screen.getByRole("button", { name: "Retry startup verification" }),
		).toBeEnabled();
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
	});

	it("acknowledges startup after the active repository has restored its drafts", async () => {
		startup();
		app.host.preferences.set("commit_drafts", {
			"/active": { subject: "restored draft", body: "restored body" },
		});
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;
		await app.settle();
		expect(app.host.count("updates_ready")).toBe(0);

		opening.release(null);
		await screen.findByDisplayValue("restored draft");
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(1);
	});
	it("retains the install intent when mounted draft recovery fails", async () => {
		startup();
		app.host.preferences.set("update_review_composer:/active", {
			corrupt: true,
		});

		app.start();
		await screen.findByRole("dialog");
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(0);
		expect(app.host.preferences.get("update_review_composer:/active")).toEqual({
			corrupt: true,
		});
	});
});
