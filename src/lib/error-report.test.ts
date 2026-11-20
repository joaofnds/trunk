import { beforeEach, describe, expect, it } from "vitest";
import { errorMessage, reportErrorToast } from "./error-report.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

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
