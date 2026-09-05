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
});
