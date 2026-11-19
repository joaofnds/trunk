import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import UpdateBlockerHarness from "../__tests__/helpers/update-blocker-harness.svelte";
import { UpdatePreparation } from "./updates-lifecycle.js";

function preparation() {
	const calls: string[] = [];
	return {
		calls,
		coordinator: new UpdatePreparation({
			prepare: async () => {
				calls.push("prepare");
				return "permit";
			},
			drained: async () => {},
			install: async () => {
				calls.push("install");
			},
			abort: async () => {
				calls.push("abort");
			},
			freeze: () => {},
			settle: async () => {},
			waiting: () => {},
		}),
	};
}

describe("mounted update blockers", () => {
	it("blocks a naming dialog and unregisters it when the component closes", async () => {
		const { calls, coordinator } = preparation();
		const view = render(UpdateBlockerHarness, {
			props: { preparation: coordinator, kind: "input" },
		});

		await expect(coordinator.install("2.0.0")).rejects.toThrow("rename branch");
		expect(calls).toEqual([]);
		await view.unmount();
		await coordinator.install("2.0.0");

		expect(calls).toEqual(["prepare", "install"]);
	});

	it("blocks an open message editor until its draft is explicitly cancelled", async () => {
		const { calls, coordinator } = preparation();
		const view = render(UpdateBlockerHarness, {
			props: { preparation: coordinator, kind: "message" },
		});
		const result = view.component.openMessage();
		await screen.findByRole("textbox");

		await expect(coordinator.install("2.0.0")).rejects.toThrow(
			"commit message editor",
		);
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(await result).toBeNull();
		await coordinator.install("2.0.0");

		expect(calls).toEqual(["prepare", "install"]);
	});
});
