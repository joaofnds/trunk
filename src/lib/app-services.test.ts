import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAppServices } from "./app-services.js";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.mocked(invoke).mockClear();
});

describe("startAppServices", () => {
	it("starts tracking scroll activity and returns its teardown", () => {
		const stop = startAppServices();

		expect(typeof stop).toBe("function");
		stop();
	});

	it("logs where perf samples land when VITE_PERF is enabled", async () => {
		vi.stubEnv("VITE_PERF", "1");
		vi.mocked(invoke).mockResolvedValue("/tmp/trunk-perf/samples.jsonl");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		const stop = startAppServices();
		await vi.waitFor(() => expect(info).toHaveBeenCalled());

		expect(info).toHaveBeenCalledWith(
			"perf samples: /tmp/trunk-perf/samples.jsonl",
		);
		stop();
	});

	it("stays silent when VITE_PERF is unset", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		const stop = startAppServices();
		await Promise.resolve();

		expect(info).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
		stop();
	});
});
