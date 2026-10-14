import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { makeCommit } from "../__tests__/helpers/factories.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type { RefsResponse } from "../lib/types.js";
import { createUndoRedoState } from "../lib/undo-redo.svelte.js";
import RepoView from "./RepoView.svelte";

let host: RepositoryReadHost;
let clock: FakeScheduler;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills();
	host.seedGraph({
		commits: [
			makeCommit({
				oid: "head-oid",
				summary: "initial commit",
				in_head_chain: true,
			}),
		],
		max_columns: 1,
		revision: 1,
	});
	host.seedResponse("list_refs", refs("main", ["main", "develop"]));
});

afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	vi.useRealTimers();
});

function refs(head: string, names: string[]): RefsResponse {
	return {
		local: names.map((name) => ({
			name,
			is_head: name === head,
			upstream: null,
			ahead: 0,
			behind: 0,
			last_commit_timestamp: 0,
		})),
		remote: [],
		tags: [],
		stashes: [],
	};
}

async function mountRepo(tabActive: boolean) {
	const view = render(RepoView, {
		props: {
			repoPath: "/repo",
			repoName: "repo",
			remoteState: createRemoteState(),
			undoRedo: createUndoRedoState(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: false,
			tabActive,
			windowFocused: false,
			reviewActive: false,
			contentMode: "hunk",
			oncontentmodechange() {},
			onreviewpanelshowingchange() {},
			onleftpanecollapsedchange() {},
			onrightpanecollapsedchange() {},
			onleftpanewidthchange() {},
			onrightpanewidthchange() {},
			onleavereview() {},
		},
		context: new Map([[SCHEDULER, clock]]),
	});
	await screen.findByText("initial commit");
	await waitFor(() =>
		expect(within(headStatus()).getByText("main")).toBeTruthy(),
	);
	await tick();

	return view;
}

function headStatus(): HTMLElement {
	const status = screen.getByText("0 files changed").parentElement;
	if (!status) throw new Error("missing worktree branch status");

	return status;
}

describe("RepoView automatic ref updates", () => {
	it("refreshes branch names and HEAD for the active tab without a worktree scan", async () => {
		await mountRepo(true);
		const before = host.count("get_status");
		host.seedResponse(
			"list_refs",
			refs("develop", ["main", "develop", "fetched-topic"]),
		);

		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			refs_only: true,
			graph_revision: 2,
		});
		await tick();
		clock.advanceBy(200);
		await screen.findByText("fetched-topic");
		await waitFor(() =>
			expect(within(headStatus()).getByText("develop")).toBeTruthy(),
		);

		expect(host.count("get_status")).toBe(before);
	});

	it("keeps an inactive tab's branch list and HEAD until activation", async () => {
		const view = await mountRepo(false);
		const before = host.count("list_refs");
		host.seedResponse(
			"list_refs",
			refs("develop", ["main", "develop", "fetched-topic"]),
		);

		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			refs_only: true,
			graph_revision: 2,
		});
		await tick();
		clock.advanceBy(200);
		await tick();

		expect(host.count("list_refs")).toBe(before);
		expect(screen.queryByText("fetched-topic")).toBeNull();
		expect(within(headStatus()).getByText("main")).toBeTruthy();

		await view.rerender({ tabActive: true });
		clock.advanceBy(200);
		await screen.findByText("fetched-topic");
		await waitFor(() =>
			expect(within(headStatus()).getByText("develop")).toBeTruthy(),
		);
	});

	it("owns no fetch timer on either the injected or global clock", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		await mountRepo(true);

		clock.advanceBy(600_000);
		vi.advanceTimersByTime(600_000);
		await tick();

		expect(host.count("git_fetch_background")).toBe(0);
	});
});
