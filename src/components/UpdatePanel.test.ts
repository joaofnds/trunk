import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../lib/updates.js";
import UpdatePanel from "./UpdatePanel.svelte";

const ready: UpdateStatus = {
	phase: "ready",
	current_version: "1.0.0",
	version: "2.0.0",
	notes: "<script>untrusted release notes</script>",
	message: null,
	downloaded: 100,
	total: 100,
	eligible: true,
	adopted: true,
};

function mount(
	status = ready,
	frozen = false,
	confirmVersion: string | null = null,
	waiting = false,
) {
	const calls: string[] = [];
	const view = render(UpdatePanel, {
		props: {
			status,
			frozen,
			waiting,
			busy: false,
			error: null,
			confirmVersion,
			onconfirm: (version: string) => calls.push(`confirm:${version}`),
			onconfirmcancel: () => calls.push("confirm-cancel"),
			onwaitcancel: () => calls.push("wait-cancel"),
			onclose: () => calls.push("close"),
			onenable: () => calls.push("enable"),
			oncheck: () => calls.push("check"),
			ondownload: (version: string) => calls.push(`download:${version}`),
			onrestart: (version: string) => calls.push(`restart:${version}`),
			oncancel: () => calls.push("cancel"),
		},
	});
	return { calls, ...view };
}

describe("update panel", () => {
	it("announces an error once when the status carries the same message", async () => {
		const message = "Update service returned an unsuccessful response";
		const view = mount({ ...ready, phase: "manual", message });

		await view.rerender({ error: message });

		expect(screen.getAllByText(message)).toHaveLength(1);
		expect(screen.getByRole("alert")).toHaveTextContent(message);
	});

	it("requires an explicit restart for the displayed prepared version", async () => {
		const { calls } = mount();

		await fireEvent.click(
			screen.getByRole("button", { name: "Restart Trunk" }),
		);

		expect(calls).toEqual(["restart:2.0.0"]);
	});

	it("shows update guidance in a nonmodal region", () => {
		mount();

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(screen.getByRole("heading", { name: "Trunk 2.0.0" })).toBeVisible();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows the installed version when no update is pending", () => {
		mount({ ...ready, phase: "idle", version: null });

		expect(screen.getByText("Installed version 1.0.0")).toBeVisible();
	});

	it("keeps long release notes out of the panel", () => {
		const notes = "<script>untrusted release notes</script>".repeat(1_000);
		const { container } = mount({ ...ready, notes });

		expect(container).not.toHaveTextContent("untrusted release notes");
		expect(container.querySelector("script")).toBeNull();
		expect(screen.getByRole("link", { name: "Update details" })).toBeVisible();
	});

	it.each([
		["2.0.0", "https://github.com/joaofnds/trunk/releases/tag/v2.0.0"],
		[
			"2.0.0+release/candidate",
			"https://github.com/joaofnds/trunk/releases/tag/v2.0.0%2Brelease%2Fcandidate",
		],
		[null, "https://github.com/joaofnds/trunk/releases/latest"],
	])("links update details to the release for %s", (version, href) => {
		mount({ ...ready, version });

		expect(
			screen.getByRole("link", { name: "Update details" }),
		).toHaveAttribute("href", href);
	});

	it("confirms the displayed version explicitly within the panel", async () => {
		const { calls } = mount(ready, false, "2.0.0");

		await fireEvent.click(
			screen.getByRole("button", { name: "Restart and install 2.0.0" }),
		);

		expect(
			screen.getByRole("heading", { name: "Restart and install 2.0.0?" }),
		).toBeVisible();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(calls).toEqual(["confirm:2.0.0"]);
	});

	it("cancels restart confirmation without requesting installation", async () => {
		const { calls } = mount(ready, false, "2.0.0");

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(calls).toEqual(["confirm-cancel"]);
	});

	it("cancels a download from its progress panel", async () => {
		const { calls } = mount({ ...ready, phase: "downloading", downloaded: 50 });

		await fireEvent.click(
			screen.getByRole("button", { name: "Cancel download" }),
		);

		expect(
			screen.getByRole("progressbar", { name: "Update download" }),
		).toHaveAttribute("value", "50");
		expect(calls).toEqual(["cancel"]);
	});

	it("keeps managed or disabled installations on the manual route", () => {
		mount({
			...ready,
			phase: "manual",
			version: null,
			eligible: false,
			adopted: false,
		});

		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toHaveAttribute(
			"href",
			"https://github.com/joaofnds/trunk/releases/latest",
		);
		expect(screen.queryByRole("button", { name: /Restart Trunk/ })).toBeNull();
	});

	it("requires adoption before offering download or restart", async () => {
		const { calls } = mount({ ...ready, adopted: false });

		await fireEvent.click(
			screen.getByRole("button", { name: "Enable updates for this copy" }),
		);

		expect(calls).toEqual(["enable"]);
		expect(screen.queryByRole("button", { name: /Restart Trunk/ })).toBeNull();
	});

	it("offers no close or restart action during preparation", () => {
		const { calls } = mount(ready, true);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Saving drafts and preparing to restart…",
		);
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
		expect(calls).toEqual([]);
	});
	it.each([
		{ stage: "while Trunk stays usable", frozen: false },
		{ stage: "while the backend finishes earlier work", frozen: true },
	])("offers to cancel a waiting restart $stage", async ({ frozen }) => {
		const { calls } = mount(ready, frozen, null, true);

		await fireEvent.click(
			screen.getByRole("button", { name: "Cancel restart" }),
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Trunk will restart when the current work finishes.",
		);
		expect(calls).toEqual(["wait-cancel"]);
	});
	it("keeps keyboard focus inside the panel while the app is frozen", async () => {
		const view = mount();
		screen.getByRole("button", { name: "Restart Trunk" }).focus();

		await view.rerender({ frozen: true });

		expect(screen.getByRole("region", { name: "Trunk updates" })).toHaveFocus();
	});
	it("keeps manual recovery available when installation cannot unfreeze", () => {
		mount({ ...ready, phase: "recovery" }, true);

		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toHaveAttribute(
			"href",
			"https://github.com/joaofnds/trunk/releases/latest",
		);
		expect(
			screen.getByText(/Keep your application data when reinstalling/),
		).toBeVisible();
		expect(
			screen.queryByText("Saving drafts and preparing to restart…"),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
	});
});
