import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import { disablePerf, enablePerf, flushPerf, type PerfSink } from "./perf.js";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

describe("safeInvoke", () => {
	it("returns resolved value on success", async () => {
		mockInvoke.mockResolvedValueOnce({ data: 42 });
		const result = await safeInvoke<{ data: number }>("test_cmd");
		expect(result).toEqual({ data: 42 });
	});

	it("parses JSON error string into TrunkError", async () => {
		mockInvoke.mockRejectedValueOnce(
			'{"code":"conflict","message":"merge conflict"}',
		);
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "conflict",
			message: "merge conflict",
		});
	});

	it("wraps non-JSON string error with unknown_error code", async () => {
		mockInvoke.mockRejectedValueOnce("raw error text");
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "unknown_error",
			message: "raw error text",
		});
	});

	it("wraps non-string error with unknown_error code and generic message", async () => {
		mockInvoke.mockRejectedValueOnce({ weird: true });
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "unknown_error",
			message: "An unexpected error occurred",
		});
	});

	it("wraps a JSON error missing its code with unknown_error", async () => {
		mockInvoke.mockRejectedValueOnce('{"message":"no code here"}');
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "unknown_error",
			message: '{"message":"no code here"}',
		});
	});

	it("wraps a JSON error whose code is not a string with unknown_error", async () => {
		mockInvoke.mockRejectedValueOnce('{"code":404,"message":"nope"}');
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "unknown_error",
			message: '{"code":404,"message":"nope"}',
		});
	});

	it("wraps a JSON null error with unknown_error", async () => {
		mockInvoke.mockRejectedValueOnce("null");
		await expect(safeInvoke("test_cmd")).rejects.toEqual({
			code: "unknown_error",
			message: "null",
		});
	});

	it("passes command name and args to invoke", async () => {
		mockInvoke.mockResolvedValueOnce("ok");
		await safeInvoke("my_cmd", { key: "val" });
		expect(mockInvoke).toHaveBeenCalledWith("my_cmd", { key: "val" });
	});
});

class FakeSink implements PerfSink {
	readonly lines: string[] = [];

	async write(lines: string[]): Promise<void> {
		this.lines.push(...lines);
	}

	names(): string[] {
		return this.lines.map((line) => JSON.parse(line).name);
	}
}

describe("safeInvoke instrumentation", () => {
	afterEach(disablePerf);

	it("times every command under its own name, with no edit at the call site", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });
		mockInvoke.mockResolvedValueOnce(undefined);

		await safeInvoke("diff_commit_file");
		await flushPerf();

		expect(sink.names()).toEqual(["invoke:diff_commit_file"]);
	});

	it("times a command that failed, so a slow error is not invisible", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });
		mockInvoke.mockRejectedValueOnce("boom");

		await expect(safeInvoke("diff_commit_file")).rejects.toBeTruthy();
		await flushPerf();

		expect(sink.names()).toEqual(["invoke:diff_commit_file"]);
	});

	it("records nothing while instrumentation is off", async () => {
		const sink = new FakeSink();
		mockInvoke.mockResolvedValueOnce(undefined);

		await safeInvoke("diff_commit_file");
		await flushPerf();

		expect(sink.lines.length).toBe(0);
	});
});
