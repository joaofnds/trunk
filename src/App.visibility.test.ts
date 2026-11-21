import { fireEvent, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import type { RefsResponse } from "./lib/types.js";
import type { UpdateStatus } from "./lib/updates.js";

const first = { id: "first", repoPath: "/first", repoName: "first" };
const second = { id: "second", repoPath: "/second", repoName: "second" };
const hiddenTopic = { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] };
const topicRefs: RefsResponse = {
	local: [
		{
			name: "topic",
			is_head: false,
			upstream: null,
			ahead: 0,
			behind: 0,
			last_commit_timestamp: 1,
			remote: null,
		},
	],
	remote: [],
	tags: [],
	stashes: [],
};
const filteredGraph = {
	commits: [makeCommit({ oid: "history", summary: "filtered history" })],
	max_columns: 1,
	checked: true,
	revision: 2,
};

let app: StartupHarness;
afterEach(() => app?.teardown());

describe("App ref visibility", () => {
	it("restores just the selected tab when saved tabs share a repository path", async () => {
		app = new StartupHarness(
			[first, { ...second, repoPath: first.repoPath }],
			second.id,
		);

		app.start();
		await screen.findByText("restored history");
		await app.prepareNextRepository();

		expect(screen.queryByRole("tab", { name: first.repoName })).toBeNull();
		expect(screen.getByRole("tab", { name: second.repoName })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(app.paths("open_repo")).toEqual([first.repoPath]);
	});

	it("loads another repository's first graph while a visibility save is held", async () => {
		app = new StartupHarness([first, second], first.id);
		app.host.seedResponse("list_refs", topicRefs);
		app.host.seedResponse("set_ref_visibility", filteredGraph);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const write = app.host.holdNextReply("prefs_set");

		try {
			await fireEvent.click(await screen.findByLabelText("Hide topic"));
			const request = await write.entered;
			expect(request).toMatchObject({ key: "ref_visibility" });

			await app.activate(second.repoName);
			await app.settle();

			expect(app.paths("get_commit_graph")).toEqual([
				first.repoPath,
				second.repoPath,
			]);
		} finally {
			write.release(null);
			await app.settle();
		}
	});

	it("finishes an accepted visibility save before freezing for a restart", async () => {
		const ready: UpdateStatus = {
			phase: "ready",
			current_version: "1.0.0",
			version: "2.0.0",
			notes: null,
			message: null,
			downloaded: 0,
			total: null,
			eligible: true,
			adopted: true,
		};
		app = new StartupHarness([first], first.id);
		app.host.seedResponse("updates_status", ready);
		app.host.seedResponse("updates_ready", ready);
		app.host.seedResponse("updates_prepare", "restart-permit");
		app.host.seedResponse("list_refs", topicRefs);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		const graph = app.host.holdNextReply("set_ref_visibility");
		const write = app.host.holdNextReply("prefs_set");

		try {
			await fireEvent.click(await screen.findByLabelText("Hide topic"));
			await graph.entered;
			await fireEvent.click(
				screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Restart and install 2.0.0" }),
			);

			graph.release(filteredGraph);
			await write.entered;
			app.clock.advanceBy(0);
			await app.settle();

			expect(app.frozen()).toBe(false);
			expect(app.host.count("updates_prepare")).toBe(0);
		} finally {
			graph.release(filteredGraph);
			write.release(null);
			await app.settle();
		}

		await app.untilRestartBegins();
		await app.settle();
		expect(app.host.preferences.get("ref_visibility")).toEqual({
			[first.repoPath]: hiddenTopic,
		});
		const visibilityWrites = app.host.requests
			.filter(
				({ cmd, args }) => cmd === "prefs_set" && args.key === "ref_visibility",
			)
			.map(({ args }) => args);
		expect(visibilityWrites.at(-1)?.__updatePermit).toBe("restart-permit");
		expect(app.host.count("updates_install")).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
