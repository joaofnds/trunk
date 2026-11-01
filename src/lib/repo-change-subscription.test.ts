import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { createCoalescedTask } from "./coalesced-task.js";
import {
	type RepoChanged,
	subscribeToRepoChanges,
} from "./repo-change-subscription.js";

let host: RepositoryReadHost;
beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
});
afterEach(() => host.dispose());

describe("subscribeToRepoChanges", () => {
	it.each<RepoChanged>([
		{ repo: "/repo", paths: ["src/a.ts", "src/b.ts"] },
		{ repo: "/repo", paths: [], graph_revision: 2 },
		{ repo: "/repo", paths: [], refs_only: true, graph_revision: 3 },
	])("delivers the complete event for %j", async (payload) => {
		const seen: RepoChanged[] = [];
		const dispose = subscribeToRepoChanges("/repo", {
			includeRefs: true,
			invalidate: (event) => seen.push(event),
		});

		await host.emitRepoChanged(payload);

		expect(seen).toEqual([payload]);
		dispose();
	});

	it("refreshes a completed command before the watcher deadline", async () => {
		const scheduler = new FakeScheduler();
		let status = "staged";
		const refresh = createCoalescedTask(scheduler, async () => {
			status = "clean";
		});
		const dispose = subscribeToRepoChanges("/repo", refresh);

		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			command_completed: true,
		});

		expect(scheduler.time).toBe(0);
		expect(status).toBe("clean");
		dispose();
		refresh.dispose();
	});

	it("runs a completed command after a busy read without advancing time", async () => {
		const scheduler = new FakeScheduler();
		const first = Promise.withResolvers<void>();
		let reads = 0;
		const refresh = createCoalescedTask(scheduler, async () => {
			reads += 1;
			if (reads === 1) await first.promise;
		});
		const dispose = subscribeToRepoChanges("/repo", refresh);
		const active = refresh.run();

		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			command_completed: true,
		});
		first.resolve();
		await active;

		expect(scheduler.time).toBe(0);
		expect(reads).toBe(2);
		dispose();
		refresh.dispose();
	});

	it("filters foreign repositories and ref-only events for file subscribers", async () => {
		const seen: RepoChanged[] = [];
		const dispose = subscribeToRepoChanges("/repo", {
			invalidate: (event) => seen.push(event),
		});

		await host.emitRepoChanged({ repo: "/other", paths: [] });
		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			refs_only: true,
			graph_revision: 3,
		});
		await host.emitRepoChanged({ repo: "/repo", paths: [] });

		expect(seen).toEqual([{ repo: "/repo", paths: [] }]);
		dispose();
	});

	it("ignores delivery after disposal even before registration finishes", async () => {
		const registration = host.holdNextReply("plugin:event|listen");
		const seen: RepoChanged[] = [];
		const dispose = subscribeToRepoChanges("/repo", {
			invalidate: (event) => seen.push(event),
		});
		await registration.entered;

		dispose();
		registration.release(1);
		await host.emitRepoChanged({ repo: "/repo", paths: [] });

		expect(seen).toEqual([]);
		expect(host.count("plugin:event|unlisten")).toBe(1);
	});
});
