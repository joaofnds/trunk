import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import {
	DEFAULT_FETCH_INTERVAL_MS,
	getFetchIntervalMs,
	setFetchIntervalMs,
	subscribeFetchInterval,
} from "./store.js";

let host: RepositoryReadHost;
beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
});
afterEach(() => host.dispose());

describe("automatic fetch preferences", () => {
	it.each([
		{ input: null, expected: DEFAULT_FETCH_INTERVAL_MS },
		{ input: "60000", expected: DEFAULT_FETCH_INTERVAL_MS },
		{ input: Number.NaN, expected: DEFAULT_FETCH_INTERVAL_MS },
		{ input: Number.POSITIVE_INFINITY, expected: DEFAULT_FETCH_INTERVAL_MS },
		{ input: -1, expected: 0 },
		{ input: 0, expected: 0 },
		{ input: 60000.9, expected: 60000 },
	])(
		"normalizes the persisted interval $input to $expected",
		async ({ input, expected }) => {
			host.preferences.set("fetch_interval_ms", input);

			expect(await getFetchIntervalMs()).toBe(expected);
		},
	);

	it.each([
		{ input: -1, expected: 0 },
		{ input: 0, expected: 0 },
		{ input: 12000.9, expected: 12000 },
		{ input: Number.NaN, expected: DEFAULT_FETCH_INTERVAL_MS },
		{ input: Number.POSITIVE_INFINITY, expected: DEFAULT_FETCH_INTERVAL_MS },
	])(
		"persists and broadcasts the normalized interval $input as $expected",
		async ({ input, expected }) => {
			const changes: number[] = [];
			const dispose = subscribeFetchInterval((interval) =>
				changes.push(interval),
			);

			await setFetchIntervalMs(input);
			dispose();
			await setFetchIntervalMs(0);

			expect(changes).toEqual([expected]);
			expect(
				host.requests
					.filter(({ cmd }) => cmd === "prefs_set")
					.map(({ args }) => args.value),
			).toEqual([expected, 0]);
		},
	);

	it("does not broadcast a preference write that failed", async () => {
		const changes: number[] = [];
		const dispose = subscribeFetchInterval((interval) =>
			changes.push(interval),
		);
		const write = host.holdNextReply("prefs_set");

		const change = setFetchIntervalMs(60000);
		await write.entered;
		write.reject({ code: "io_error", message: "Cannot save" });
		await expect(change).rejects.toMatchObject({ code: "io_error" });

		expect(changes).toEqual([]);
		dispose();
	});
});
