import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { describe, expect, it, onTestFinished } from "vitest";
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
const panel = createRawSnippet<[() => void]>((close) => ({
	render: () =>
		'<section aria-label="Trunk updates"><a href="https://github.com/joaofnds/trunk/releases">Update details</a><button>Close</button></section>',
	setup: (element) => {
		const button = element.querySelector("button");
		const closePanel = () => close()();
		button?.addEventListener("click", closePanel);
		return () => button?.removeEventListener("click", closePanel);
	},
}));
function focusSomethingElse() {
	const elsewhere = document.createElement("button");
	document.body.append(elsewhere);
	onTestFinished(() => elsewhere.remove());
	elsewhere.focus();
}
function mount(status = idle) {
	const actions: string[] = [];
	const view = render(UpdateControl, {
		status,
		busy: false,
		frozen: false,
		waiting: false,
		open: false,
		children: panel,
		onclose: () => {},
		oncheck: () => actions.push("check"),
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
	it("opens the panel on keyboard focus without starting a download", async () => {
		const { actions } = mount({
			...idle,
			phase: "available",
			version: "2.0.0",
		});

		await fireEvent.focus(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(actions).toEqual([]);
	});
	it("routes Tab into the panel and Escape back without reopening it", async () => {
		mount({ ...idle, phase: "available", version: "2.0.0" });
		const trigger = screen.getByRole("button", {
			name: "Download update 2.0.0",
		});
		trigger.focus();
		await fireEvent.keyDown(trigger, { key: "Tab" });
		expect(screen.getByRole("link", { name: "Update details" })).toHaveFocus();

		await fireEvent.keyDown(
			screen.getByRole("link", { name: "Update details" }),
			{ key: "Escape" },
		);

		expect(trigger).toHaveFocus();
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("leaves Tab between panel actions to the browser", async () => {
		mount({ ...idle, phase: "available", version: "2.0.0" });
		await fireEvent.focus(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);
		const details = screen.getByRole("link", { name: "Update details" });
		details.focus();

		const unhandled = await fireEvent.keyDown(details, { key: "Tab" });

		expect(unhandled).toBe(true);
		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
	});
	it("returns focus to the update button when the panel closes", async () => {
		mount();
		const trigger = screen.getByRole("button", { name: "Check for updates" });
		trigger.focus();
		await fireEvent.keyDown(trigger, { key: "Tab" });
		const close = screen.getByRole("button", { name: "Close" });
		close.focus();

		await fireEvent.click(close);

		expect(trigger).toHaveFocus();
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("reveals ready guidance on hover even without release notes", async () => {
		mount({ ...idle, phase: "ready", version: "2.0.0", notes: null });
		const focused = document.activeElement;

		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(document.activeElement).toBe(focused);
	});
	it("keeps an explicitly opened panel visible while the pointer is elsewhere", async () => {
		const view = mount();
		await view.rerender({ open: true });

		await fireEvent.pointerMove(document.body);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
	});
	it("keeps keyboard-focused actions visible when the pointer leaves", async () => {
		mount();
		const trigger = screen.getByRole("button", { name: "Check for updates" });
		trigger.focus();
		await fireEvent.keyDown(trigger, { key: "Tab" });

		await fireEvent.pointerMove(document.body);

		expect(screen.getByRole("link", { name: "Update details" })).toHaveFocus();
	});
	it("keeps the focused trigger's panel visible after mouse leave", async () => {
		mount();
		const trigger = screen.getByRole("button", { name: "Check for updates" });
		trigger.focus();

		await fireEvent.mouseLeave(trigger, { relatedTarget: document.body });

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
	});
	it("keeps the hovered panel visible when focus moves elsewhere", async () => {
		mount();
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Check for updates" }),
		);

		focusSomethingElse();
		await tick();

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
	});
	it("keeps the hovered panel visible while focus is inside it", async () => {
		mount();
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Check for updates" }),
		);
		screen.getByRole("link", { name: "Update details" }).focus();
		await tick();

		await fireEvent.pointerMove(document.body);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
	});
	it("hides the hovered panel when the pointer moves away", async () => {
		mount();
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Check for updates" }),
		);

		await fireEvent.pointerMove(document.body);

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("hides the keyboard-focused panel when focus moves elsewhere", async () => {
		mount();
		screen.getByRole("button", { name: "Check for updates" }).focus();

		focusSomethingElse();
		await tick();

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("hides the panel when focus leaves its actions for elsewhere", async () => {
		mount();
		const trigger = screen.getByRole("button", { name: "Check for updates" });
		trigger.focus();
		await fireEvent.keyDown(trigger, { key: "Tab" });

		focusSomethingElse();
		await tick();

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("hides the hovered panel when its Close is pressed", async () => {
		mount();
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Check for updates" }),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("hides the hovered panel when its button is pressed", async () => {
		mount();
		const trigger = screen.getByRole("button", { name: "Check for updates" });
		await fireEvent.mouseEnter(trigger);

		await fireEvent.click(trigger);

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("opens cancellation controls during download", async () => {
		const { rerender, actions } = mount({
			...idle,
			phase: "downloading",
			downloaded: 40,
			total: 100,
		});
		await rerender({ busy: true });

		await fireEvent.click(
			screen.getByRole("button", { name: "Downloading update: 40%" }),
		);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(actions).toEqual([]);
	});
	it("reopens the panel while a restart waits on earlier work", async () => {
		const view = mount({ ...idle, phase: "ready", version: "2.0.0" });
		await view.rerender({ busy: true, waiting: true });

		await fireEvent.click(
			screen.getByRole("button", { name: "Waiting to restart…" }),
		);

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(view.actions).toEqual([]);
	});
	it("keeps the preparation panel visible on Escape", async () => {
		const view = mount({ ...idle, phase: "ready", version: "2.0.0" });
		await view.rerender({ open: true, frozen: true });

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		).toBeDisabled();
	});
});
