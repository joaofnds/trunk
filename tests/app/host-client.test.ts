import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { RefsResponse } from "../../src/lib/types.js";
import {
	HostClient,
	type RepoSpec,
	type SpecStep,
} from "./harness/host-client.js";

describe("host client", () => {
	const oneCommit: RepoSpec = {
		steps: [
			{ step: "file", path: "README.md", content: "hello" },
			{ step: "commit", message: "Initial commit" },
		],
	};
	let host: HostClient | undefined;

	afterEach(async () => {
		await host?.shutdown();
		host = undefined;
	});

	it("answers list_refs for a seeded repository", async () => {
		host = await HostClient.spawn();
		const path = await host.seedRepo(oneCommit);
		await host.invoke("open_repo", { path });

		const refs = await host.invoke<RefsResponse>("list_refs", { path });

		expect(refs.local.map((branch) => branch.name)).toEqual(["main"]);
	});

	it("writes preferences under its temporary home", async () => {
		host = await HostClient.spawn();

		await host.invoke("prefs_set", { key: "zoom_level", value: 1.25 });

		expect(filesUnder(host.home)).toContain("trunk-prefs.json");
	});

	it("runs the reply hook before the reply's promise settles", async () => {
		host = await HostClient.spawn();
		const order: string[] = [];

		const answered = host.invoke("prefs_get", { key: "zoom_level" }, () =>
			order.push("hook"),
		);
		await answered.then(() => order.push("promise"));

		expect(order).toEqual(["hook", "promise"]);
	});

	it("rejects a seed step it cannot parse", async () => {
		host = await HostClient.spawn();
		const unknown = { step: "teleport" } as unknown as SpecStep;

		const seeded = host.seedRepo({ steps: [unknown] });

		await expect(seeded).rejects.toThrow("unreadable request");
	});

	it("removes the temporary home on shutdown", async () => {
		const spawned = await HostClient.spawn();

		await spawned.shutdown();

		expect(existsSync(spawned.home)).toBe(false);
	});

	it("ends a CLI run that has not exited on shutdown", async () => {
		host = await HostClient.spawn();
		const repo = await host.seedRepo(oneCommit);
		const watching = Promise.withResolvers<void>();
		const ended = expect(
			host.cli(["review", "watch", "--repo", repo], (chunk) => {
				if (chunk.startsWith("# watching")) watching.resolve();
			}),
		).rejects.toMatchObject({ cause: { name: "AbortError" } });
		await watching.promise;

		await host.shutdown();

		await ended;
	});

	it("refuses a CLI run once shut down", async () => {
		host = await HostClient.spawn();
		await host.shutdown();

		const run = host.cli(["--version"]);

		await expect(run).rejects.toThrow("host shut down");
	});
});

function filesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);
}
