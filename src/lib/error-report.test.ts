import { message } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	errorMessage,
	reportErrorDialog,
	reportErrorToast,
} from "./error-report.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

vi.mock("@tauri-apps/plugin-dialog", () => ({
	message: vi.fn().mockResolvedValue(undefined),
}));

describe("errorMessage", () => {
	it("returns a native Error's message", () => {
		expect(errorMessage(new Error("plugin disabled"), "fallback")).toBe(
			"plugin disabled",
		);
	});

	it("returns a TrunkError's message", () => {
		const thrown = { code: "dirty_workdir", message: "uncommitted changes" };

		expect(errorMessage(thrown, "fallback")).toBe("uncommitted changes");
	});

	it("returns a raw string rejection unchanged", () => {
		expect(errorMessage("clipboard unavailable", "fallback")).toBe(
			"clipboard unavailable",
		);
	});

	it("returns the fallback for a value carrying no message", () => {
		expect(errorMessage({ code: "no_message_here" }, "fallback")).toBe(
			"fallback",
		);
	});
});

describe("reportErrorToast", () => {
	beforeEach(() => {
		_resetToasts();
	});

	it("raises an error toast carrying the message", () => {
		reportErrorToast(
			{ code: "git_conflict", message: "merge conflict" },
			"Merge failed",
		);

		expect(toasts.items.map((t) => [t.message, t.kind])).toEqual([
			["merge conflict", "error"],
		]);
	});

	it("raises the fallback when the value carries no message", () => {
		reportErrorToast({ code: "git_conflict" }, "Merge failed");

		expect(toasts.items.map((t) => t.message)).toEqual(["Merge failed"]);
	});
});

describe("reportErrorDialog", () => {
	beforeEach(() => {
		vi.mocked(message).mockClear();
	});

	it("opens an error dialog carrying the message under the given title", async () => {
		await reportErrorDialog(
			{ code: "git_conflict", message: "merge conflict" },
			"Merge Error",
			"Merge failed",
		);

		expect(vi.mocked(message)).toHaveBeenCalledWith("merge conflict", {
			title: "Merge Error",
			kind: "error",
		});
	});

	it("opens the dialog with the fallback when the value carries no message", async () => {
		await reportErrorDialog(
			{ code: "git_conflict" },
			"Merge Error",
			"Merge failed",
		);

		expect(vi.mocked(message)).toHaveBeenCalledWith("Merge failed", {
			title: "Merge Error",
			kind: "error",
		});
	});
});
