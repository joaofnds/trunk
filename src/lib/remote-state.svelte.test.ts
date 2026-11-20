import { describe, expect, it } from "vitest";
import { createRemoteState } from "./remote-state.svelte.js";

describe("createRemoteState", () => {
	it("returns object with correct defaults", () => {
		const state = createRemoteState();
		expect(state.isRunning).toBe(false);
		expect(state.error).toBe(null);
	});

	it("returns independent instances — mutating one does not affect the other", () => {
		const a = createRemoteState();
		const b = createRemoteState();
		a.isRunning = true;
		expect(b.isRunning).toBe(false);
	});

	it("returns independent instances for error", () => {
		const a = createRemoteState();
		const b = createRemoteState();
		a.error = { code: "test", message: "err" };
		expect(b.error).toBe(null);
	});
});
