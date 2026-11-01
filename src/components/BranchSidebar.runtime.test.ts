import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import SidebarRefreshHarness from "../__tests__/helpers/sidebar-refresh-harness.svelte";
import { SCHEDULER } from "../lib/scheduler.js";

let host: RepositoryReadHost;
let clock: FakeScheduler;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills();
});
afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
});

function refs(name: string) {
	return {
		local: [
			{
				name,
				is_head: true,
				upstream: null,
				ahead: 0,
				behind: 0,
				last_commit_timestamp: 1,
			},
		],
		remote: [],
		tags: [],
		stashes: [],
	};
}

describe("BranchSidebar completed commands", () => {
	it("updates refs after a busy read without advancing the refresh timer", async () => {
		host.seedResponse("list_refs", refs("initial"));
		render(SidebarRefreshHarness, {
			context: new Map([[SCHEDULER, clock]]),
		});
		await screen.findByText("initial");
		const first = host.holdNextReply("list_refs");
		const second = host.holdNextReply("list_refs");

		await fireEvent.click(screen.getByText("Complete command"));
		await first.entered;
		await fireEvent.click(screen.getByText("Complete command"));
		expect(host.count("list_refs")).toBe(2);
		first.release(refs("older"));
		await second.entered;
		second.release(refs("latest"));

		await screen.findByText("latest");
		expect(screen.queryByText("older")).toBeNull();
		expect(host.count("list_refs")).toBe(3);
	});
});
