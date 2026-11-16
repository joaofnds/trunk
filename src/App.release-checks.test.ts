import { fireEvent, screen, within } from "@testing-library/svelte";
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
const available: UpdateStatus = {
	...manual,
	phase: "available",
	version: "2.0.0",
};

function startup(status = manual) {
	app = new StartupHarness([], "missing");
	app.host.seedResponse("updates_status", status);
	app.host.seedResponse("updates_ready", status);
	app.host.seedResponse("updates_check", available);
	app.start();
	return app.settle();
}

describe("App GitHub release checks", () => {
	it("checks from the native menu without automatic installation eligibility", async () => {
		await startup();

		await app.host.emit("updates-open", null);
		await app.settle();

		expect(app.host.count("updates_check")).toBe(1);
		const panel = screen.getByRole("region", { name: "Trunk updates" });
		expect(panel).toHaveTextContent("Version 2.0.0 is available");
		expect(
			within(panel).getByRole("button", { name: "Download update" }),
		).toBeEnabled();
		expect(
			within(panel).getByRole("link", { name: "Update details" }),
		).toHaveAttribute(
			"href",
			"https://github.com/joaofnds/trunk/releases/tag/v2.0.0",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it.each([false, true])(
		"opens GitHub instead of installing for an unadopted copy with eligibility %s",
		async (eligible) => {
			await startup({ ...available, eligible });

			await fireEvent.click(
				screen.getByRole("button", { name: "Download update 2.0.0" }),
			);
			await app.settle();

			expect(app.host.opener.opened).toEqual([
				"https://github.com/joaofnds/trunk/releases/tag/v2.0.0",
			]);
			expect(app.host.count("updates_download")).toBe(0);
			expect(app.host.count("updates_prepare")).toBe(0);
			expect(app.host.count("updates_install")).toBe(0);
		},
	);
	it("opens GitHub from the manual hover panel download button", async () => {
		await startup(available);
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Download update" }),
		);
		await app.settle();

		expect(app.host.opener.opened).toEqual([
			"https://github.com/joaofnds/trunk/releases/tag/v2.0.0",
		]);
		expect(app.host.count("updates_download")).toBe(0);
	});
	it("checks automatically for manual copies and announces availability only through the icon", async () => {
		await startup();

		app.clock.advanceBy(15_000);
		await app.settle();

		expect(app.host.count("updates_check")).toBe(1);
		expect(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		).toBeEnabled();
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("keeps background check failures quiet", async () => {
		await startup();
		const check = app.host.holdNextReply("updates_check");

		app.clock.advanceBy(15_000);
		await check.entered;
		check.reject({ code: "update_error", message: "GitHub is unavailable" });
		await app.settle();

		expect(app.host.count("updates_check")).toBe(1);
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Check for updates" }),
		).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});
	it("shows explicit check failures inline and offers another check", async () => {
		await startup();
		const check = app.host.holdNextReply("updates_check");

		await app.host.emit("updates-open", null);
		await check.entered;
		check.reject({ code: "update_error", message: "GitHub is unavailable" });
		await app.settle();

		const panel = screen.getByRole("region", { name: "Trunk updates" });
		expect(within(panel).getByRole("alert")).toHaveTextContent(
			"GitHub is unavailable",
		);
		expect(
			within(panel).getByRole("button", { name: "Check for updates" }),
		).toBeEnabled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
