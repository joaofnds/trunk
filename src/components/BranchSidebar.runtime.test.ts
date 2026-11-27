import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import SidebarRefreshHarness from "../__tests__/helpers/sidebar-refresh-harness.svelte";
import { EVERYTHING_VISIBLE } from "../lib/ref-visibility.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type {
	BranchInfo,
	GraphResponse,
	RebasePreviewTarget,
	RefsResponse,
} from "../lib/types.js";
import BranchSidebar from "./BranchSidebar.svelte";

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

function branch(name: string, remote: string | null = null): BranchInfo {
	return {
		name,
		is_head: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		last_commit_timestamp: 1,
		remote,
	};
}

function refs(name: string): RefsResponse {
	return {
		local: [{ ...branch(name), is_head: true }],
		remote: [],
		tags: [],
		stashes: [],
	};
}

function graphAtRevision(revision: number): GraphResponse {
	return { commits: [], max_columns: 0, revision, checked: true };
}

describe("BranchSidebar branch creation", () => {
	beforeEach(() => {
		host.seedResponse("list_refs", refs("main"));
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});
	});

	it("opens Local and focuses the branch name from its create button", async () => {
		await fireEvent.click(
			await screen.findByRole("button", { name: "Local (1)" }),
		);
		expect(screen.queryByText("main")).not.toBeInTheDocument();

		await fireEvent.click(
			screen.getByRole("button", { name: "Create new branch" }),
		);

		expect(screen.queryByPlaceholderText("New branch name")).toHaveFocus();
		expect(screen.getByText("main")).toBeInTheDocument();
	});

	it("refocuses the open branch name and keeps the draft", async () => {
		const create = await screen.findByRole("button", {
			name: "Create new branch",
		});
		await fireEvent.click(create);
		const input = screen.getByPlaceholderText("New branch name");
		await fireEvent.input(input, { target: { value: "draft" } });
		create.focus();

		await fireEvent.click(create);

		expect(input).toHaveFocus();
		expect(input).toHaveValue("draft");
	});

	it("discards the draft when Escape cancels branch creation", async () => {
		const create = await screen.findByRole("button", {
			name: "Create new branch",
		});
		await fireEvent.click(create);
		const input = screen.getByPlaceholderText("New branch name");
		await fireEvent.input(input, { target: { value: "draft" } });

		await fireEvent.keyDown(input, { key: "Escape" });

		expect(input).not.toBeInTheDocument();
		expect(host.count("create_branch")).toBe(0);
		await fireEvent.click(create);
		expect(screen.getByPlaceholderText("New branch name")).toHaveFocus();
		expect(screen.getByPlaceholderText("New branch name")).toHaveValue("");
	});
});

describe("BranchSidebar remote grouping", () => {
	it.each(["__proto__", "constructor"])(
		"groups and checks out a branch under the remote %s",
		async (remote) => {
			host.seedResponse("list_refs", {
				...refs("main"),
				remote: [branch(`${remote}/team/topic`, remote)],
			});
			host.seedResponse("checkout_remote_branch", "team/topic");
			render(BranchSidebar, {
				props: { repoPath: "/repo", remoteState: createRemoteState() },
			});
			await fireEvent.click(
				await screen.findByRole("button", { name: "Remote (1)" }),
			);

			await fireEvent.dblClick(
				screen.getByRole("button", { name: "team/topic" }),
			);

			expect(screen.getByTestId("remote-group-subheader")).toHaveTextContent(
				remote,
			);
			expect(host.requests).toContainEqual({
				cmd: "checkout_remote_branch",
				args: { path: "/repo", remoteRef: `refs/remotes/${remote}/team/topic` },
			});
		},
	);

	it("focuses the filter with slash and reveals the matching remote until cleared", async () => {
		host.seedResponse("list_refs", {
			...refs("main"),
			remote: [branch("origin/topic", "origin")],
		});
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});
		const section = await screen.findByRole("button", { name: "Remote (1)" });
		section.focus();
		await fireEvent.keyDown(section, { key: "/" });

		const field = screen.getByRole("textbox", {
			name: "Filter branches, tags, stashes",
		});
		expect(field).toHaveFocus();
		await fireEvent.input(field, { target: { value: "TOPIC" } });
		expect(screen.getByRole("button", { name: "topic" })).toBeVisible();
		await fireEvent.keyDown(field, { key: "Escape" });
		expect(screen.queryByRole("button", { name: "topic" })).toBeNull();
	});

	it("offers to hide only matching branches within a filtered remote", async () => {
		host.seedResponse("list_refs", {
			...refs("main"),
			remote: [
				branch("origin/main", "origin"),
				branch("origin/topic", "origin"),
			],
		});
		host.seedResponse("set_ref_visibility", graphAtRevision(1));
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});
		await fireEvent.click(await screen.findByText("Remote (2)"));
		await fireEvent.input(
			screen.getByRole("textbox", { name: "Filter branches, tags, stashes" }),
			{
				target: { value: "topic" },
			},
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Hide matching origin branches" }),
		);
		await waitFor(() =>
			expect(host.preferences.get("ref_visibility")).toEqual({
				"/repo": {
					...EVERYTHING_VISIBLE,
					hiddenRefs: ["refs/remotes/origin/topic"],
				},
			}),
		);
	});

	it("keeps numeric group names in ascending order before other groups", async () => {
		host.seedResponse("list_refs", {
			...refs("main"),
			remote: [
				branch("10/topic", "10"),
				branch("origin/main", "origin"),
				branch("2/topic", "2"),
				branch("backup/main", "backup"),
			],
		});
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: "Remote (4)" }),
		);

		expect(
			screen
				.getAllByTestId("remote-group-subheader")
				.map((header) => header.textContent?.trim()),
		).toEqual(["2", "10", "origin", "backup"]);
	});
});

describe("BranchSidebar ref navigation", () => {
	it.each([
		["local", "release", "refs/heads/release"],
		["tags", "release", "refs/tags/release"],
		["remote", "release", "refs/remotes/upstream/release"],
		["remote", "standalone", "refs/remotes/standalone"],
	])("selects the %s ref displayed as %s", async (section, name, refName) => {
		const navigated: string[] = [];
		const listedRefs: RefsResponse = {
			local: [branch("release"), branch("upstream/release")],
			remote: [branch("upstream/release", "up"), branch("standalone")],
			tags: [
				{
					name: "refs/tags/release",
					short_name: "release",
					ref_type: "Tag",
					is_head: false,
					color_index: 0,
				},
			],
			stashes: [],
		};
		host.seedResponse("list_refs", listedRefs);
		render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				onrefnavigate: (ref) => navigated.push(ref),
			},
			context: new Map([[SCHEDULER, clock]]),
		});
		await fireEvent.click(await screen.findByText("Remote (2)"));
		await fireEvent.click(screen.getByText("Tags (1)"));
		const rows = within(screen.getByTestId(`branch-section-${section}`));

		await fireEvent.click(rows.getByRole("button", { name }));

		expect(navigated).toEqual([refName]);
	});
});

describe("BranchSidebar actions on colliding remote labels", () => {
	const slashless = "refs/remotes/standalone";
	const grouped = "refs/remotes/unknown/standalone";
	const navigated: string[] = [];
	const nextGraph: GraphResponse = {
		commits: [],
		max_columns: 0,
		revision: 1,
		checked: true,
	};
	const previews: RebasePreviewTarget[] = [];

	beforeEach(async () => {
		navigated.length = 0;
		previews.length = 0;
		host.seedResponse("list_refs", {
			...refs("main"),
			remote: [branch("standalone"), branch("unknown/standalone", "unknown")],
		});
		host.seedResponse("checkout_remote_branch", "standalone");
		host.seedResponse("set_ref_visibility", nextGraph);
		render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				onrefnavigate: (ref) => navigated.push(ref),
				onopenrebaseeditor: (target) => previews.push(target),
			},
		});
		await fireEvent.click(await screen.findByText("Remote (2)"));
	});

	it("navigates to the two refs displayed as standalone", async () => {
		const [first, second] = screen.getAllByRole("button", {
			name: "standalone",
		});

		await fireEvent.click(first);
		await fireEvent.click(second);

		expect(navigated).toEqual([slashless, grouped]);
	});

	it("checks out the slashless ref from its row", async () => {
		const [row] = screen.getAllByRole("button", { name: "standalone" });

		await fireEvent.dblClick(row);

		expect(host.requests).toContainEqual({
			cmd: "checkout_remote_branch",
			args: { path: "/repo", remoteRef: slashless },
		});
	});

	it("requests the branch preview for the slashless ref from its menu", async () => {
		const [row] = screen.getAllByRole("button", { name: "standalone" });

		await fireEvent.contextMenu(row);
		await waitFor(() =>
			expect(host.contextMenu.items().length).toBeGreaterThan(0),
		);
		host.contextMenu.choose("Interactive Rebase standalone...");

		expect(previews).toEqual([{ kind: "branch", refName: slashless }]);
	});

	it.each([
		["row", "Hide standalone"],
		["group", "Hide all unknown branches"],
	])("hides each ref from its %s eye", async (_level, label) => {
		const [first, second] = screen.getAllByLabelText(label);
		const firstHide = host.holdNextReply("set_ref_visibility");
		const secondHide = host.holdNextReply("set_ref_visibility");

		await fireEvent.click(first);
		const firstRequest = await firstHide.entered;
		firstHide.release(nextGraph);

		expect(firstRequest.visibility).toEqual({
			hiddenRefs: [slashless],
			hiddenStashes: [],
		});
		await fireEvent.click(second);
		const secondRequest = await secondHide.entered;
		secondHide.release(nextGraph);

		expect(secondRequest.visibility).toEqual({
			hiddenRefs: [slashless, grouped],
			hiddenStashes: [],
		});
	});

	it("hides both refs from the Remote section eye", async () => {
		const hide = host.holdNextReply("set_ref_visibility");

		await fireEvent.click(screen.getByLabelText("Hide all Remote refs"));
		const request = await hide.entered;
		hide.release(nextGraph);

		expect(request.visibility).toEqual({
			hiddenRefs: [slashless, grouped],
			hiddenStashes: [],
		});
	});
});

describe("BranchSidebar ref visibility", () => {
	const hiddenTopic = {
		hiddenRefs: ["refs/heads/topic"],
		hiddenStashes: [],
	};
	beforeEach(() => {
		host.seedResponse("list_refs", {
			...refs("main"),
			local: [...refs("main").local, branch("topic")],
		});
	});

	it("publishes and saves the last click when a hide is still in flight", async () => {
		const hide = host.holdNextReply("set_ref_visibility");
		const show = host.holdNextReply("set_ref_visibility");
		const displayed: number[] = [];
		render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				onvisibilitychanged: (graph) => displayed.push(graph.revision),
			},
		});

		await fireEvent.click(await screen.findByLabelText("Hide topic"));
		const hideRequest = await hide.entered;
		await fireEvent.click(screen.getByLabelText("Show topic"));
		const requestsWhileHiding = host.count("set_ref_visibility");
		show.release(graphAtRevision(2));
		hide.release(graphAtRevision(1));
		const showRequest = await show.entered;
		await waitFor(() => {
			expect(displayed.at(-1)).toBe(2);
			expect(host.preferences.get("ref_visibility")).toEqual({
				"/repo": EVERYTHING_VISIBLE,
			});
		});

		expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
		expect(hideRequest.visibility).toEqual(hiddenTopic);
		expect(showRequest.visibility).toEqual(EVERYTHING_VISIBLE);
		expect(requestsWhileHiding).toBe(1);
	});

	it("saves an in-flight change to the repository where it was made", async () => {
		const hide = host.holdNextReply("set_ref_visibility");
		const displayed: number[] = [];
		const view = render(BranchSidebar, {
			props: {
				repoPath: "/first",
				remoteState: createRemoteState(),
				onvisibilitychanged: (graph) => displayed.push(graph.revision),
			},
		});
		await fireEvent.click(await screen.findByLabelText("Hide topic"));
		await hide.entered;

		await view.rerender({ repoPath: "/second" });
		hide.release(graphAtRevision(1));

		await waitFor(() => {
			expect(host.preferences.get("ref_visibility")).toEqual({
				"/first": hiddenTopic,
			});
		});
		expect(displayed).toEqual([]);
		expect(screen.getByLabelText("Hide topic")).toBeInTheDocument();
	});

	it("applies a click made while saved visibility is loading", async () => {
		const stored = { hiddenRefs: [], hiddenStashes: ["older-stash"] };
		const read = host.holdNextReply("prefs_get");
		host.seedResponse("set_ref_visibility", graphAtRevision(1));
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});
		await read.entered;

		await fireEvent.click(await screen.findByLabelText("Hide topic"));
		read.release({ "/repo": stored });

		await waitFor(() => {
			expect(host.preferences.get("ref_visibility")).toEqual({
				"/repo": { ...stored, hiddenRefs: hiddenTopic.hiddenRefs },
			});
		});
		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
	});

	it("honors a Hide click even when the delayed preference already hides that ref", async () => {
		const read = host.holdNextReply("prefs_get");
		const ready = Promise.withResolvers<void>();
		host.seedResponse("set_ref_visibility", graphAtRevision(1));
		render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				onvisibilityresolved: ready.resolve,
			},
		});
		await read.entered;

		await fireEvent.click(await screen.findByLabelText("Hide topic"));
		read.release({ "/repo": hiddenTopic });
		await ready.promise;

		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
		expect(host.count("set_ref_visibility")).toBe(1);
	});

	it("restores visibility after a prior sidebar leaves while awaiting its listener", async () => {
		host.preferences.set("ref_visibility", { "/repo": hiddenTopic });
		host.seedResponse("set_ref_visibility", graphAtRevision(1));
		const prior = render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				repoListenerSettled: false,
			},
		});
		await screen.findByLabelText("Show topic");
		const ready = Promise.withResolvers<void>();

		prior.unmount();
		render(BranchSidebar, {
			props: {
				repoPath: "/repo",
				remoteState: createRemoteState(),
				onvisibilityresolved: ready.resolve,
			},
		});
		await ready.promise;

		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
		expect(host.count("set_ref_visibility")).toBe(1);
	});

	it("restores the eye after a rejected hide so the click can be retried", async () => {
		const rejected = host.holdNextReply("set_ref_visibility");
		host.seedResponse("set_ref_visibility", graphAtRevision(1));
		render(BranchSidebar, {
			props: { repoPath: "/repo", remoteState: createRemoteState() },
		});
		await fireEvent.click(await screen.findByLabelText("Hide topic"));
		await rejected.entered;

		rejected.reject({ code: "graph_changed", message: "Graph changed" });
		await fireEvent.click(await screen.findByLabelText("Hide topic"));

		await waitFor(() => {
			expect(host.preferences.get("ref_visibility")).toEqual({
				"/repo": hiddenTopic,
			});
		});
		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
	});

	it.each([
		["absent", "Local (0 of 2)", 1],
		["main", "Local (1 of 2)", 0],
	])(
		"counts matches for %s and omits an eye with no eligible refs",
		async (filter, label, emptyMessages) => {
			render(BranchSidebar, {
				props: { repoPath: "/repo", remoteState: createRemoteState() },
			});
			await screen.findByLabelText("Hide topic");

			await fireEvent.input(
				screen.getByRole("textbox", { name: "Filter branches, tags, stashes" }),
				{
					target: { value: filter },
				},
			);

			expect(screen.getByText(label)).toBeInTheDocument();
			expect(screen.queryByTestId("branch-section-visibility-btn")).toBeNull();
			expect(screen.getByLabelText("Create new branch")).toBeEnabled();
			expect(screen.queryAllByText("No matching refs or stashes")).toHaveLength(
				emptyMessages,
			);
		},
	);
});

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
