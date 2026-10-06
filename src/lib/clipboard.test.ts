import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copySha, copyText } from "./clipboard.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn(),
}));

describe("copySha", () => {
	beforeEach(() => {
		_resetToasts();
		vi.mocked(writeText).mockReset();
		vi.mocked(writeText).mockResolvedValue(undefined);
	});

	it("copies the full oid to the clipboard", async () => {
		await copySha("abc1234567890");

		expect(vi.mocked(writeText)).toHaveBeenCalledWith("abc1234567890");
	});

	it("confirms the copy with a success toast of the short oid", async () => {
		await copySha("abc1234567890");

		expect(toasts.items).toEqual([
			{ id: expect.any(Number), message: "Copied abc1234", kind: "success" },
		]);
	});
});

describe("copyText", () => {
	beforeEach(() => {
		_resetToasts();
		vi.mocked(writeText).mockReset();
		vi.mocked(writeText).mockResolvedValue(undefined);
	});

	it("copies the name to the clipboard", async () => {
		await copyText("feature/login");

		expect(vi.mocked(writeText)).toHaveBeenCalledWith("feature/login");
	});

	it("confirms the copy with a success toast of the whole name", async () => {
		await copyText("feature/login");

		expect(toasts.items).toEqual([
			{
				id: expect.any(Number),
				message: "Copied feature/login",
				kind: "success",
			},
		]);
	});
});

describe.each([
	["copySha", () => copySha("abc1234567890")],
	["copyText", () => copyText("feature/login")],
])("%s when the clipboard write fails", (_name, copy) => {
	beforeEach(() => {
		_resetToasts();
		vi.mocked(writeText).mockReset();
		vi.mocked(writeText).mockRejectedValue(new Error("plugin disabled"));
	});

	it("shows an error toast with the failure message", async () => {
		await copy();

		expect(toasts.items).toEqual([
			{
				id: expect.any(Number),
				message: "Failed to copy: plugin disabled",
				kind: "error",
			},
		]);
	});

	it("never rejects", async () => {
		await expect(copy()).resolves.toBeUndefined();
	});
});
