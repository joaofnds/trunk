import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { reviewPanelProps } from "../__tests__/helpers/review-props.js";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import { aPinnedThread, aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	createReviewComments,
	type ReviewCommentsManager,
} from "../lib/review-comments.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type { CommentResolution, Review } from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";

const anchor = aThread({
	id: "anchor",
	text: "anchored comment",
	stale: true,
	commit_oid: "anchor-oid",
	anchor: {
		commit_oid: "anchor-oid",
		file_path: "file.txt",
		source: "Diff",
		side: "New",
		start_line: 1,
		end_line: 1,
	},
});
const pin = {
	...aPinnedThread({
		id: "pin",
		filePath: "local.txt",
		startLine: 1,
		endLine: 1,
		resolvedStartLine: null,
	}),
	stale: true,
};
const review: Review = {
	id: "REVIEW01",
	title: "Review",
	state: "settled",
	visible_to_agent: false,
	archived: false,
	thread_count: 2,
	unresolved_count: 2,
	pending_count: 0,
	created_at: 0,
};
const missing: CommentResolution[] = [
	{ id: "anchor", resolvable: false, reason: "CommitGone" },
	{ id: "pin", resolvable: false, reason: "ContentGone" },
];
let host: RepositoryReadHost;
let clock: FakeScheduler;
let manager: ReviewCommentsManager;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	installDomPolyfills();
	host.seedResponse("list_reviews", [review]);
	host.seedResponse("get_active_review", review.id);
	host.seedResponse("list_threads", [anchor, pin]);
	host.seedResponse("list_session_commits", [
		aSessionCommit({
			oid: "anchor-oid",
			summary: "anchor commit",
			exists: false,
		}),
	]);
	host.seedResponse("resolve_threads", missing);
	host.seedResponse("resolve_thread_refs", [
		{ id: "anchor", resolvable: true, reason: null },
	]);
});

afterEach(() => {
	cleanup();
	manager.destroy();
	host.dispose();
	restoreDomPolyfills();
});

async function mountPanel(): Promise<void> {
	manager = createReviewComments("/repo", clock);
	render(ReviewPanel, {
		props: reviewPanelProps({ reviewComments: manager }),
		context: new Map([[SCHEDULER, clock]]),
	});
	await screen.findByTitle("Commit gone. Only the saved excerpt survives.");
	await screen.findByTitle("Code gone. Only the saved excerpt survives.");
	clock.advanceBy(200);
	await waitFor(() => expect(host.count("refresh_thread_staleness")).toBe(1));
	await manager.refresh();
	await tick();
}

async function deliverRefs(): Promise<void> {
	await host.emitRepoChanged({
		repo: "/repo",
		paths: [],
		refs_only: true,
		graph_revision: 2,
	});
	clock.advanceBy(200);
	await waitFor(() =>
		expect(host.count("refresh_thread_ref_staleness")).toBe(1),
	);
	await waitFor(() => expect(clock.pending).toBe(1));
	clock.advanceBy(200);
}

describe("refs-only review refresh", () => {
	it("defers inactive publications, recovers a missing anchor on activation, and preserves file-pin state", async () => {
		await mountPanel();
		manager.setActive(false);
		const reads = host.count("list_threads");
		const fullResolutions = host.count("resolve_threads");
		const stalenessPasses = host.count("refresh_thread_staleness");
		host.seedResponse("list_threads", [{ ...anchor, stale: false }, pin]);
		host.seedResponse("list_session_commits", [
			aSessionCommit({ oid: "anchor-oid", summary: "anchor commit" }),
		]);

		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			refs_only: true,
			graph_revision: 2,
		});
		await host.emitRepoChanged({
			repo: "/repo",
			paths: [],
			refs_only: true,
			graph_revision: 3,
		});
		clock.advanceBy(400);
		await tick();
		expect(host.count("refresh_thread_ref_staleness")).toBe(0);
		expect(host.count("list_threads")).toBe(reads);

		manager.setActive(true);
		clock.advanceBy(200);
		await waitFor(() =>
			expect(host.count("refresh_thread_ref_staleness")).toBe(1),
		);
		await waitFor(() => expect(clock.pending).toBe(1));
		clock.advanceBy(200);
		await waitFor(() =>
			expect(
				screen.queryByTitle("Commit gone. Only the saved excerpt survives."),
			).toBeNull(),
		);

		expect(
			screen.getByTitle("Code gone. Only the saved excerpt survives."),
		).toBeInTheDocument();
		expect(manager.threads.find(({ id }) => id === "pin")?.stale).toBe(true);
		expect(manager.revisionScope).toBe("refs");
		expect(host.count("resolve_threads")).toBe(fullResolutions);
		expect(host.count("resolve_thread_refs")).toBe(1);
		expect(host.count("refresh_thread_staleness")).toBe(stalenessPasses);
		expect(host.count("open_current_file")).toBe(0);
	});

	it("keeps local file staleness checks immediate while the tab is inactive", async () => {
		await mountPanel();
		manager.setActive(false);
		const local = host.holdNextReply("refresh_thread_staleness");

		await host.emitRepoChanged({ repo: "/repo", paths: ["local.txt"] });
		clock.advanceBy(200);
		expect(await local.entered).toEqual({ path: "/repo" });
		local.release(0);

		expect(host.count("refresh_thread_ref_staleness")).toBe(0);
	});

	it("does not replace a pending full resolution with a refs-only answer", async () => {
		await mountPanel();
		const full = host.holdNextReply("resolve_threads");
		await host.emit("reviews-changed", "/repo");
		clock.advanceBy(200);
		await full.entered;

		await deliverRefs();
		await waitFor(() => expect(manager.revisionScope).toBe("refs"));
		expect(host.count("resolve_thread_refs")).toBe(0);
		full.release([
			{ id: "anchor", resolvable: false, reason: "CommitGone" },
			{ id: "pin", resolvable: true, reason: null },
		]);
		await waitFor(() => expect(host.count("resolve_thread_refs")).toBe(1));
		await waitFor(() =>
			expect(
				screen.queryByTitle("Code gone. Only the saved excerpt survives."),
			).toBeNull(),
		);
		await waitFor(() =>
			expect(
				screen.queryByTitle("Commit gone. Only the saved excerpt survives."),
			).toBeNull(),
		);
	});
});
