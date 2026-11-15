import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../lib/updates.js";
import UpdateControl from "./UpdateControl.svelte";

const idle: UpdateStatus = {
	phase: "idle",
	current_version: "1.0.0",
	version: null,
	notes: null,
	message: null,
	downloaded: 0,
	total: null,
	eligible: true,
	adopted: true,
};
function mount(status = idle) {
	const actions: string[] = [];
	const view = render(UpdateControl, {
		status,
		busy: false,
		oncheck: () => actions.push("check"),
		ondetails: () => actions.push("details"),
		ondownload: (version) => actions.push(`download:${version}`),
		onrestart: (version) => actions.push(`confirm:${version}`),
	});
	return { actions, ...view };
}
describe("update control", () => {
	it.each([
		{ phase: "idle", label: "Check for updates", action: "check" },
		{
			phase: "available",
			label: "Download update 2.0.0",
			action: "download:2.0.0",
		},
		{
			phase: "ready",
			label: "Restart to update to 2.0.0",
			action: "confirm:2.0.0",
		},
	] as const)(
		"offers the $phase action directly",
		async ({ phase, label, action }) => {
			const { actions } = mount({ ...idle, phase, version: "2.0.0" });

			await fireEvent.click(screen.getByRole("button", { name: label }));

			expect(actions).toEqual([action]);
		},
	);
	it("makes release notes available from keyboard focus without starting a download", async () => {
		const { actions } = mount({
			...idle,
			phase: "available",
			version: "2.0.0",
			notes: "<script>release notes</script>",
		});

		await fireEvent.focus(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);

		expect(
			screen.getByRole("region", { name: "Trunk 2.0.0 release notes" }),
		).toHaveTextContent("<script>release notes</script>");
		expect(document.querySelector("script")).toBeNull();
		expect(actions).toEqual([]);
	});
	it("routes Tab into release notes and Escape back without reopening them", async () => {
		mount({ ...idle, phase: "available", version: "2.0.0", notes: "Changes" });
		const trigger = screen.getByRole("button", {
			name: "Download update 2.0.0",
		});
		trigger.focus();
		await fireEvent.keyDown(trigger, { key: "Tab" });
		expect(
			screen.getByRole("button", { name: "Update details" }),
		).toHaveFocus();

		await fireEvent.keyDown(
			screen.getByRole("button", { name: "Update details" }),
			{ key: "Escape" },
		);

		expect(trigger).toHaveFocus();
		expect(
			screen.queryByRole("region", { name: "Trunk 2.0.0 release notes" }),
		).toBeNull();
	});
	it("leaves Escape available after a status change removes release notes", async () => {
		const view = mount({
			...idle,
			phase: "available",
			version: "2.0.0",
			notes: "Changes",
		});
		const trigger = screen.getByRole("button", {
			name: "Download update 2.0.0",
		});
		await fireEvent.focus(trigger);
		await view.rerender({ status: idle });

		const unhandled = await fireEvent.keyDown(trigger, { key: "Escape" });

		expect(unhandled).toBe(true);
	});
	it("reveals notes on hover without moving keyboard focus", async () => {
		mount({ ...idle, phase: "available", version: "2.0.0", notes: "Changes" });
		const focused = document.activeElement;

		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);

		expect(
			screen.getByRole("region", { name: "Trunk 2.0.0 release notes" }),
		).toBeVisible();
		expect(document.activeElement).toBe(focused);
	});
	it("opens cancellation details while displaying download progress", async () => {
		const { actions, rerender } = mount({
			...idle,
			phase: "downloading",
			downloaded: 40,
			total: 100,
		});
		await rerender({ busy: true });

		expect(
			screen.getByRole("button", { name: "Downloading update: 40%" }),
		).toBeEnabled();
		await fireEvent.click(
			screen.getByRole("button", { name: "Downloading update: 40%" }),
		);

		expect(actions).toEqual(["details"]);
	});
	it("keeps unsupported installations on the manual route", async () => {
		const { actions } = mount({ ...idle, phase: "manual", eligible: false });

		await fireEvent.click(
			screen.getByRole("button", { name: "Check for updates" }),
		);

		expect(actions).toEqual(["details"]);
	});
	it("prevents a duplicate check while checking", () => {
		mount({ ...idle, phase: "checking" });

		expect(
			screen.getByRole("button", { name: "Checking for updates…" }),
		).toBeDisabled();
	});
});
