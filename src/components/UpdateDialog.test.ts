import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../lib/updates.js";
import UpdateDialog from "./UpdateDialog.svelte";

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

function mount(status = ready, frozen = false) {
	const calls: string[] = [];
	const view = render(UpdateDialog, {
		props: {
			status,
			frozen,
			busy: false,
			error: null,
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

describe("update dialog", () => {
	it("requires an explicit restart for the displayed prepared version", async () => {
		const { calls } = mount();

		await fireEvent.click(
			screen.getByRole("button", { name: "Restart and install 2.0.0" }),
		);

		expect(calls).toEqual(["restart:2.0.0"]);
	});

	it("renders release notes as text", () => {
		const { container } = mount();

		expect(screen.getByText(ready.notes ?? "")).toBeInTheDocument();
		expect(container.querySelector("script")).toBeNull();
	});

	it("keeps managed or disabled installations on the manual route", () => {
		mount({ ...ready, phase: "manual", eligible: false, adopted: false });

		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toHaveAttribute(
			"href",
			"https://github.com/joaofnds/trunk/releases/latest",
		);
		expect(
			screen.queryByRole("button", { name: /Restart and install/ }),
		).toBeNull();
	});

	it("requires adoption before offering download or restart", async () => {
		const { calls } = mount({ ...ready, adopted: false });

		await fireEvent.click(
			screen.getByRole("button", { name: "Enable updates for this copy" }),
		);

		expect(calls).toEqual(["enable"]);
		expect(
			screen.queryByRole("button", { name: /Restart and install/ }),
		).toBeNull();
	});

	it("cannot close or restart twice during preparation", async () => {
		const { calls } = mount(ready, true);

		await fireEvent(
			screen.getByRole("dialog"),
			new Event("cancel", { cancelable: true }),
		);

		expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Restart and install 2.0.0" }),
		).toBeDisabled();
		expect(calls).toEqual([]);
	});
});
