import { setImmediate } from "node:timers/promises";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import type { OwnedTimer } from "./owned-timer.js";
import { updates } from "./updates.js";
import { UpdateCheckScheduler } from "./updates-scheduler.js";

afterEach(() => clearMocks());

function fixture(random = 0.5, check?: () => Promise<void>) {
	const clock = new FakeScheduler();
	let handle: number | undefined;
	const timer: OwnedTimer = {
		arm(callback, delay) {
			this.cancel();
			handle = clock.setTimeout(callback, delay);
		},
		cancel() {
			if (handle !== undefined) clock.clearTimeout(handle);
			handle = undefined;
		},
	};
	let failures = true;
	const checks: number[] = [];
	const scheduler = new UpdateCheckScheduler(
		timer,
		() => clock.time,
		() => random,
		async () => {
			checks.push(clock.time);
			if (check) return check();
			if (failures) throw new Error("offline");
		},
	);
	async function advance(ms: number) {
		clock.advanceBy(ms);
		await Promise.resolve();
		await Promise.resolve();
	}
	return {
		clock,
		scheduler,
		checks,
		advance,
		succeed: () => {
			failures = false;
		},
	};
}

describe("UpdateCheckScheduler", () => {
	it("retries a structured native check failure through the real IPC adapter", async () => {
		const commands: string[] = [];
		mockIPC((command) => {
			commands.push(command);
			return Promise.reject(
				JSON.stringify({ code: "update_error", message: "offline" }),
			);
		});
		const f = fixture(0.5, async () => {
			await updates.check();
		});
		f.scheduler.update(true, false);

		await f.advance(15_000);
		await setImmediate();
		await f.advance(60_000);
		await setImmediate();

		expect(commands).toEqual(["updates_check", "updates_check"]);
	});
	it.each([
		{ random: 0, delay: 48_000 },
		{ random: 1, delay: 72_000 },
	])("jitters a retry to $delay milliseconds", async ({ random, delay }) => {
		const f = fixture(random);
		f.scheduler.update(true, false);
		await f.advance(15_000);

		await f.advance(delay - 1);
		expect(f.checks).toHaveLength(1);
		await f.advance(1);

		expect(f.checks).toHaveLength(2);
	});
	it("bounds retries while keeping the regular check schedule", async () => {
		const f = fixture();
		f.scheduler.update(true, false);

		await f.advance(15_000);
		await f.advance(60_000);
		await f.advance(120_000);
		await f.advance(240_000);
		await f.advance(60 * 60_000);

		expect(f.checks).toEqual([15_000, 75_000, 195_000, 435_000]);
		await f.advance(3 * 60 * 60_000);
		expect(f.checks).toHaveLength(5);
	});
	it("preserves the remaining retry delay across preparation", async () => {
		const f = fixture();
		f.scheduler.update(true, false);
		await f.advance(15_000);
		await f.advance(20_000);

		f.scheduler.update(true, true);
		await f.advance(500_000);
		expect(f.clock.pending).toBe(0);
		f.scheduler.update(true, false);
		await f.advance(39_999);
		expect(f.checks).toHaveLength(1);
		await f.advance(1);

		expect(f.checks).toHaveLength(2);
	});
	it("resets the exhausted budget after an explicit action", async () => {
		const f = fixture();
		f.scheduler.update(true, false);
		await f.advance(15_000);
		await f.advance(60_000);
		await f.advance(120_000);
		await f.advance(240_000);

		f.scheduler.reset();
		await f.advance(4 * 60 * 60_000);
		await f.advance(60_000);

		expect(f.checks).toHaveLength(6);
	});
	it("clears retry attempts after a successful check and stops when disabled", async () => {
		const f = fixture();
		f.scheduler.update(true, false);
		await f.advance(15_000);
		f.succeed();
		await f.advance(60_000);
		await f.advance(240_000);
		expect(f.checks).toHaveLength(2);

		f.scheduler.update(false, false);
		await f.advance(4 * 60 * 60_000);

		expect(f.checks).toHaveLength(2);
		expect(f.clock.pending).toBe(0);
	});
});
