import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../tests/app/harness/dom.js";
import { makeCommit, makeRef } from "./__tests__/helpers/factories.js";
import { RepositoryReadHost } from "./__tests__/helpers/repository-read-host.js";
import App from "./App.svelte";
import { SCHEDULER } from "./lib/scheduler.js";
import { _resetToasts, toasts } from "./lib/toast.svelte.js";

let host: RepositoryReadHost;

const branch = (name: string, is_head: boolean) => ({
	name,
	is_head,
	upstream: null,
	ahead: 0,
	behind: 0,
	last_commit_timestamp: 0,
	remote: null,
});

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	installDomPolyfills();
	host.preferences.set("open_tabs", [
		{ id: "tab-1", repoPath: "/repo", repoName: "repo" },
	]);
	host.preferences.set("active_tab_id", "tab-1");
	host.preferences.set("fetch_interval_ms", 0);
	host.seedGraph({
		commits: [
			makeCommit({
				oid: "main-oid",
				summary: "on main",
				is_head: true,
				refs: [makeRef({ short_name: "main", is_head: true })],
			}),
			makeCommit({
				oid: "feature-oid",
				summary: "on feature",
				refs: [makeRef({ short_name: "feature" })],
			}),
			makeCommit({
				oid: "fix-oid",
				summary: "on origin/fix",
				refs: [
					makeRef({
						short_name: "origin/fix",
						name: "refs/remotes/origin/fix",
						ref_type: "RemoteBranch",
					}),
				],
			}),
			makeCommit({
				oid: "tag-oid",
				summary: "tagged v1",
				refs: [
					makeRef({
						short_name: "v1",
						name: "refs/tags/v1",
						ref_type: "Tag",
					}),
				],
			}),
		],
		max_columns: 1,
		checked: true,
		revision: 1,
	});
	host.seedResponse("list_refs", {
		local: [branch("main", true), branch("feature", false)],
		remote: [{ ...branch("origin/fix", false), remote: "origin" }],
		tags: [
			makeRef({ short_name: "v1", name: "refs/tags/v1", ref_type: "Tag" }),
		],
		stashes: [],
	});
	host.seedResponse("list_remotes", ["origin"]);
	_resetToasts();
});

afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	_resetToasts();
});

async function openAppWhilePushing(): Promise<void> {
	render(App, { context: new Map([[SCHEDULER, new FakeScheduler()]]) });
	await screen.findAllByText("on main");
	host.holdNextReply("git_push");
	await fireEvent.click(screen.getByRole("button", { name: "Push" }));
	await waitFor(() => expect(host.count("git_push")).toBe(1));
}

function sidebar() {
	return within(screen.getByTestId("branch-sidebar"));
}

async function sidebarRow(name: string): Promise<Element> {
	if (name === "fix")
		await fireEvent.click(await sidebar().findByText("Remote (1)"));
	if (name === "v1")
		await fireEvent.click(await sidebar().findByText("Tags (1)"));
	return sidebar().findByText(name);
}

async function graphPill(name: string): Promise<Element> {
	const pills = (await screen.findAllByRole("button", { name })).filter(
		(button) => button.closest("foreignObject") !== null,
	);
	expect(pills).toHaveLength(1);
	return pills[0] as Element;
}

async function remoteEntriesOn(target: Element, labels: string[]) {
	await fireEvent.contextMenu(target);
	await waitFor(() =>
		expect(host.contextMenu.items().map(({ label }) => label)).toEqual(
			expect.arrayContaining(labels),
		),
	);
	return host.contextMenu.items().filter(({ label }) => labels.includes(label));
}

const MENUS = [
	["the checked-out branch", "main", ["Pull", "Push"]],
	["another branch", "feature", ["Push feature"]],
	["a remote branch", "fix", ["Delete"]],
	["a tag", "v1", ["Push v1 to origin", "Delete v1 from origin"]],
] as const;

describe("while a push runs", () => {
	it.each(MENUS)(
		"turns off what the sidebar menu of %s would do on a remote",
		async (_, row, labels) => {
			await openAppWhilePushing();

			const entries = await remoteEntriesOn(await sidebarRow(row), [...labels]);

			expect(entries).toEqual(
				labels.map((label) => ({ label, enabled: false })),
			);
		},
	);

	it.each(MENUS)(
		"turns off what the graph menu of %s would do on a remote",
		async (_, pill, labels) => {
			await openAppWhilePushing();

			const entries = await remoteEntriesOn(
				await graphPill(pill === "fix" ? "origin/fix" : pill),
				[...labels],
			);

			expect(entries).toEqual(
				labels.map((label) => ({ label, enabled: false })),
			);
		},
	);
});

async function openApp(): Promise<void> {
	render(App, { context: new Map([[SCHEDULER, new FakeScheduler()]]) });
	await screen.findAllByText("on main");
}

async function menuOn(target: Element): Promise<string[]> {
	await fireEvent.contextMenu(target);
	await waitFor(() => expect(host.contextMenu.items()).not.toEqual([]));
	return host.contextMenu.items().map(({ label }) => label);
}

const BRANCHES = [
	["the checked-out branch", "main"],
	["another branch", "feature"],
] as const;
const REMOTE_ENTRIES = ["Pull", "Push", "Push feature"];

describe("in a repository with no remotes", () => {
	beforeEach(() => host.seedResponse("list_remotes", []));

	it.each(BRANCHES)(
		"leaves the remote entries out of the sidebar menu of %s",
		async (_, name) => {
			await openApp();

			const labels = await menuOn(await sidebarRow(name));

			expect(labels.filter((label) => REMOTE_ENTRIES.includes(label))).toEqual(
				[],
			);
		},
	);

	it.each(BRANCHES)(
		"leaves the remote entries out of the graph menu of %s",
		async (_, name) => {
			await openApp();

			const labels = await menuOn(await graphPill(name));

			expect(labels.filter((label) => REMOTE_ENTRIES.includes(label))).toEqual(
				[],
			);
		},
	);
});

describe("when the remotes cannot be read", () => {
	it("says so as the branch menu opens", async () => {
		await openApp();
		host
			.holdNextReply("list_remotes")
			.reject({ code: "git_error", message: "bad config" });

		await menuOn(await sidebarRow("feature"));

		expect(toasts.items.map(({ message }) => message)).toEqual([
			"Could not read the remotes, so the menu leaves them out. bad config",
		]);
	});
});
