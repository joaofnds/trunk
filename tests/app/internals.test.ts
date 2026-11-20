import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHostChannel } from "./fakes/host-channel.js";
import { TauriInternals } from "./harness/internals.js";

describe("TauriInternals", () => {
	let internals: TauriInternals | undefined;

	afterEach(() => {
		internals?.uninstall();
		internals = undefined;
	});

	it("delivers an event read in the same turn as its listener's registration reply", () => {
		const host = new FakeHostChannel();
		internals = new TauriInternals(host);
		internals.install();
		const received: unknown[] = [];
		void listen<string>("repo-changed", (event) =>
			received.push(event.payload),
		);

		host.reply(1);
		host.push("repo-changed", "/repo");

		expect(received).toEqual(["/repo"]);
	});

	it("withholds an event pushed before the registration reply", () => {
		const host = new FakeHostChannel();
		internals = new TauriInternals(host);
		internals.install();
		const received: unknown[] = [];
		void listen<string>("repo-changed", (event) =>
			received.push(event.payload),
		);

		host.push("repo-changed", "/repo");
		host.reply(1);

		expect(received).toEqual([]);
	});

	it("describes the commands it sent, their answers and the events it read, in order", async () => {
		const host = new FakeHostChannel();
		internals = new TauriInternals(host);
		internals.install();
		const invoke = window.__TAURI_INTERNALS__?.invoke as (
			cmd: string,
			args: Record<string, unknown>,
		) => Promise<unknown>;

		const graph = invoke("get_commit_graph", { path: "/repo", loaded: 1 });
		host.push("repo-changed", { repo: "/repo", refs_only: true });
		host.reply({ commits: [] });
		await graph;

		expect(internals.describeTrail()).toBe(
			[
				'sent get_commit_graph {"loaded":1}',
				'read event repo-changed {"repo":"/repo","refs_only":true}, heard by 0 listeners',
				"answered get_commit_graph",
			].join("\n"),
		);
	});

	it("keeps only the latest hundred entries of its trail", () => {
		const host = new FakeHostChannel();
		internals = new TauriInternals(host);
		internals.install();

		for (let n = 0; n < 101; n++) host.push(`event-${n}`, null);

		const trail = internals.describeTrail().split("\n");
		expect(trail).toHaveLength(100);
		expect(trail[0]).toBe("read event event-1 null, heard by 0 listeners");
	});
});
