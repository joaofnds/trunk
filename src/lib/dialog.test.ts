import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { ask } from "./dialog.js";

function answering(pressed: (buttons: unknown) => string): unknown[] {
	const asked: unknown[] = [];
	mockIPC((command, args) => {
		if (command !== "plugin:dialog|message") return null;
		const { buttons } = args as { buttons: unknown };
		asked.push(buttons);
		return pressed(buttons);
	});
	return asked;
}

afterEach(() => {
	clearMocks();
});

describe("ask", () => {
	it("offers the action it names beside Cancel", async () => {
		const asked = answering(() => "Discard");

		const confirmed = await ask("Discard this hunk?", {
			title: "Discard Hunk",
			kind: "warning",
			okLabel: "Discard",
		});

		expect(confirmed).toBe(true);
		expect(asked).toEqual([{ OkCancelCustom: ["Discard", "Cancel"] }]);
	});

	it("declines when the user presses Cancel", async () => {
		answering(() => "Cancel");

		const confirmed = await ask("Discard this hunk?", {
			title: "Discard Hunk",
			kind: "warning",
			okLabel: "Discard",
		});

		expect(confirmed).toBe(false);
	});
});
