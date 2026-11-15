import { describe, expect, it } from "vitest";
import {
	type UpdateParticipant,
	UpdatePreparation,
} from "./updates-lifecycle.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class Host {
	calls: string[] = [];
	frozen = false;
	async prepare(version: string) {
		this.calls.push(`prepare:${version}`);
		return "permit";
	}
	async install(version: string, token: string) {
		this.calls.push(`install:${version}:${token}`);
	}
	async abort(token: string) {
		this.calls.push(`abort:${token}`);
	}
	freeze(value: boolean) {
		this.frozen = value;
	}
	async settle() {}
}

function participant(
	flush: (token: string) => Promise<void>,
	generation = () => "1",
): UpdateParticipant {
	return {
		capture: () => ({ generation: generation(), blocker: null, flush }),
	};
}

describe("update preparation", () => {
	it("flushes the captured drafts with the permit before installing the accepted version", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		preparation.register(
			participant(async (token) => {
				host.calls.push(`flush:${token}`);
			}),
		);

		await preparation.install("2.0.0");

		expect(host.calls).toEqual([
			"prepare:2.0.0",
			"flush:permit",
			"install:2.0.0:permit",
		]);
		expect(host.frozen).toBe(true);
	});

	it("defers before closing backend admission when an editor cannot be recovered", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		preparation.register({
			capture: () => ({
				generation: "1",
				blocker: "Finish the merge editor",
				flush: async () => {},
			}),
		});

		await expect(preparation.install("2.0.0")).rejects.toThrow(
			"Finish the merge editor",
		);

		expect(host.calls).toEqual([]);
		expect(host.frozen).toBe(false);
	});

	it("awaits every flush before aborting after a failed save", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		const held = deferred();
		const entered = deferred();
		preparation.register(
			participant(async () => {
				throw new Error("disk full");
			}),
		);
		preparation.register(
			participant(async () => {
				entered.resolve();
				await held.promise;
				host.calls.push("second-saved");
			}),
		);

		const result = preparation.install("2.0.0");
		const rejected = expect(result).rejects.toThrow("disk full");
		await entered.promise;
		expect(host.calls).toEqual(["prepare:2.0.0"]);
		expect(host.frozen).toBe(true);
		held.resolve();
		await rejected;

		expect(host.calls).toEqual([
			"prepare:2.0.0",
			"second-saved",
			"abort:permit",
		]);
		expect(host.frozen).toBe(false);
	});

	it("aborts when a draft changes during its acknowledged flush", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		let generation = "1";
		preparation.register(
			participant(
				async () => {
					generation = "2";
				},
				() => generation,
			),
		);

		await expect(preparation.install("2.0.0")).rejects.toThrow("changed");

		expect(host.calls).toEqual(["prepare:2.0.0", "abort:permit"]);
	});
});

describe("update recovery admission", () => {
	it.each([
		{
			outcome: "rejects",
			discard: (error: Error): Promise<void> => Promise.reject(error),
		},
		{
			outcome: "throws",
			discard: (error: Error): Promise<void> => {
				throw error;
			},
		},
	])(
		"reports retained snapshots when cleanup $outcome while leaving controls usable",
		async ({ discard }) => {
			const host = new Host();
			const preparation = new UpdatePreparation(host);
			const original = new Error("save refused");
			const cleanup = new Error("snapshot disk unavailable");
			const entered = deferred();
			const held = deferred();
			preparation.register({
				capture: () => ({
					generation: "1",
					blocker: null,
					flush: async () => {
						throw original;
					},
					discard: () => discard(cleanup),
				}),
			});
			preparation.register({
				capture: () => ({
					generation: "1",
					blocker: null,
					flush: async () => {},
					discard: async () => {
						entered.resolve();
						await held.promise;
					},
				}),
			});

			const result = preparation.install("2.0.0");
			const error = result.catch((reason: unknown) => reason);
			await entered.promise;
			expect(host.frozen).toBe(false);
			held.resolve();

			expect(await error).toBeInstanceOf(AggregateError);
			expect(await error).toMatchObject({ errors: [original, cleanup] });
			expect(host.calls).toEqual(["prepare:2.0.0", "abort:permit"]);
		},
	);
	it("keeps controls frozen when the backend cannot reopen admission", async () => {
		const host = new Host();
		host.install = async () => {
			throw new Error("replacement failed");
		};
		host.abort = async () => {
			throw new Error("manual recovery required");
		};
		const preparation = new UpdatePreparation(host);

		await expect(preparation.install("2.0.0")).rejects.toThrow(
			"manual recovery required",
		);

		expect(host.frozen).toBe(true);
	});

	it("keeps existing recovery snapshots when a blocker stops preparation", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		let discarded = false;
		preparation.register({
			capture: () => ({
				generation: "1",
				blocker: "recover previous draft",
				flush: async () => {},
				discard: async () => {
					discarded = true;
				},
			}),
		});

		await expect(preparation.install("2.0.0")).rejects.toThrow(
			"recover previous draft",
		);

		expect(discarded).toBe(false);
	});
});

describe("synchronous flush failures", () => {
	it("settles the remaining participants when one flush throws before returning a promise", async () => {
		const host = new Host();
		const preparation = new UpdatePreparation(host);
		preparation.register(
			participant(() => {
				throw new Error("save refused");
			}),
		);
		preparation.register(
			participant(async () => {
				host.calls.push("second-saved");
			}),
		);

		await expect(preparation.install("2.0.0")).rejects.toThrow("save refused");

		expect(host.calls).toEqual([
			"prepare:2.0.0",
			"second-saved",
			"abort:permit",
		]);
	});
});
