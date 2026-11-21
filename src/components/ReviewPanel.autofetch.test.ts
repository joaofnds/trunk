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
import { REPO_CHANGE_DELAY_MS } from "../lib/coalesced-task.js";
import { invokesSettled } from "../lib/invoke.js";
import {
	createReviewComments,
	type ReviewCommentsManager,
} from "../lib/review-comments.svelte.js";
import { realScheduler, SCHEDULER } from "../lib/scheduler.js";
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

async function mountPanel() {
	manager = createReviewComments("/repo", clock);
	const props = reviewPanelProps({ reviewComments: manager });
	const view = render(ReviewPanel, {
		props,
		context: new Map([[SCHEDULER, clock]]),
	});
	await screen.findByTitle("Commit gone. Only the saved excerpt survives.");
	await screen.findByTitle("Code gone. Only the saved excerpt survives.");
	await waitFor(() => expect(host.count("refresh_thread_staleness")).toBe(1));
	await manager.refresh();
	await tick();
	return { props, view };
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
}

describe("refs-only review refresh", () => {
	it("defers panel-only anchor reads while a diff covers the review", async () => {
		const { props, view } = await mountPanel();
		const resolutions = host.count("resolve_threads");
		await view.rerender({ shown: false, keysActive: false });
		host.seedResponse("resolve_threads", [missing[0]]);

		await manager.refresh();
		await tick();
		expect(host.count("resolve_threads")).toBe(resolutions);
		await view.rerender(props);

		await waitFor(() => {
			expect(
				screen.queryByTitle("Code gone. Only the saved excerpt survives."),
			).toBeNull();
		});
		expect(host.count("resolve_threads")).toBe(resolutions + 1);
	});

	it("retries an anchor lookup that failed after its tab was hidden", async () => {
		const { props, view } = await mountPanel();
		const failed = host.holdNextReply("resolve_threads");
		await manager.refresh();
		await failed.entered;
		await view.rerender({ tabActive: false, keysActive: false });
		host.seedResponse("resolve_threads", [missing[0]]);

		failed.reject({ code: "store", message: "anchor lookup failed" });
		await invokesSettled(realScheduler);
		await view.rerender(props);

		await waitFor(() => {
			expect(
				screen.queryByTitle("Code gone. Only the saved excerpt survives."),
			).toBeNull();
		});
	});

	it("retries a failed refs lookup when the review returns and keeps file-pin results", async () => {
		const { props, view } = await mountPanel();
		const fullReads = host.count("resolve_threads");
		const failed = host.holdNextReply("resolve_thread_refs");
		await deliverRefs();
		await failed.entered;
		await view.rerender({ shown: false, keysActive: false });

		failed.reject({ code: "store", message: "anchor lookup failed" });
		await invokesSettled(realScheduler);
		await view.rerender(props);

		await waitFor(() => {
			expect(
				screen.queryByTitle("Commit gone. Only the saved excerpt survives."),
			).toBeNull();
		});
		expect(
			screen.getByTitle("Code gone. Only the saved excerpt survives."),
		).toBeVisible();
		expect(host.count("resolve_threads")).toBe(fullReads);
	});
	it("resolves changed thread anchors only when their repository tab returns", async () => {
		const { props, view } = await mountPanel();
		const resolutions = host.count("resolve_threads");
		const revision = manager.revision;
		await view.rerender({ keysActive: false, tabActive: false });
		host.seedResponse("resolve_threads", [missing[0]]);

		await host.emit("reviews-changed", "/repo");
		clock.advanceBy(REPO_CHANGE_DELAY_MS);
		await waitFor(() => expect(manager.revision).toBeGreaterThan(revision));
		expect(host.count("resolve_threads")).toBe(resolutions);

		await view.rerender({ ...props, tabActive: true });

		await waitFor(() => {
			expect(
				screen.queryByTitle("Code gone. Only the saved excerpt survives."),
			).toBeNull();
		});
		expect(host.count("resolve_threads")).toBe(resolutions + 1);
	});

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
		await waitFor(() =>
			expect(host.count("refresh_thread_ref_staleness")).toBe(1),
		);
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
		clock.advanceBy(REPO_CHANGE_DELAY_MS);
		const local = host.holdNextReply("refresh_thread_staleness");

		await host.emitRepoChanged({ repo: "/repo", paths: ["local.txt"] });
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
