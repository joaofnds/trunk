import { afterEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "./fakes/scheduler.js";
import { HostClient } from "./harness/host-client.js";
import { describeTimeout, driveWaitsWith, waitFor } from "./harness/wait.js";

const NEVER = () => null;

describe("a wait that times out", () => {
	afterEach(() => {
		describeTimeout(null);
		driveWaitsWith(null);
	});

	it("drives registered application work between polls", async () => {
		let ready = false;
		let drives = 0;
		driveWaitsWith((elapsedMs) => {
			drives += 1;
			expect(elapsedMs).toBe(5);
			ready = true;
		});

		await expect(
			waitFor("virtual work", () => (ready ? true : null)),
		).resolves.toBe(true);
		expect(drives).toBe(1);
	});

	it("names what it was waiting for", async () => {
		const expired = waitFor("the stash in the graph", NEVER, 0);

		await expect(expired).rejects.toThrow("the stash in the graph");
	});

	it("reports the outstanding host commands when a source is registered", async () => {
		describeTimeout(() => "invoke #7 list_commits, outstanding 4200ms");

		const expired = waitFor("the graph", NEVER, 0);

		await expect(expired).rejects.toThrow(
			"invoke #7 list_commits, outstanding 4200ms",
		);
	});

	it("still fails cleanly when the source itself throws", async () => {
		describeTimeout(() => {
			throw new Error("diagnostics blew up");
		});

		const expired = waitFor("the graph", NEVER, 0);

		await expect(expired).rejects.toThrow("the graph");
	});
});

describe("the application scheduler", () => {
	it("fires every timer inside an interval in deadline order", () => {
		const scheduler = new FakeScheduler();
		const fired: string[] = [];
		scheduler.setTimeout(() => fired.push("later"), 200);
		scheduler.setTimeout(() => fired.push("earlier"), 100);

		scheduler.advanceBy(200);

		expect(fired).toEqual(["earlier", "later"]);
	});
});

describe("a host client's outstanding commands", () => {
	let host: HostClient | undefined;

	afterEach(async () => {
		await host?.shutdown();
		host = undefined;
	});

	it("reads as none while nothing is in flight", async () => {
		host = await HostClient.spawn();

		expect(host.describeOutstanding()).toContain("no host command outstanding");
	});

	it("names the command still waiting on the host", async () => {
		host = await HostClient.spawn();
		const path = await host.seedRepo({
			steps: [
				{ step: "file", path: "README.md", content: "hello" },
				{ step: "commit", message: "Initial commit" },
			],
		});
		await host.invoke("open_repo", { path });

		const inFlight = host.invoke("list_refs", { path });
		const described = host.describeOutstanding();
		await inFlight;

		expect(described).toContain("list_refs");
	});

	it("includes the host's stderr so a crash is visible", async () => {
		host = await HostClient.spawn();

		expect(host.describeOutstanding()).toContain("host stderr");
	});
});
