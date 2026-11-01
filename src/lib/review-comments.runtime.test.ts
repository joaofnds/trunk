import { waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import {
	createReviewComments,
	type ReviewCommentsManager,
} from "./review-comments.svelte.js";
import type { Review } from "./types.js";

let host: RepositoryReadHost;
let manager: ReviewCommentsManager;
let clock: FakeScheduler;
const review: Review = {
	id: "review",
	title: "before",
	state: "settled",
	visible_to_agent: false,
	archived: false,
	thread_count: 0,
	unresolved_count: 0,
	pending_count: 0,
	created_at: 0,
};

beforeEach(async () => {
	host = new RepositoryReadHost();
	host.install();
	clock = new FakeScheduler();
	host.seedResponse("list_reviews", [review]);
	host.seedResponse("get_active_review", review.id);
	host.seedResponse("refresh_thread_staleness", 0);
	manager = createReviewComments("/repo", clock);
	await waitFor(() => expect(manager.activeReview?.title).toBe("before"));
});
afterEach(() => {
	manager.destroy();
	host.dispose();
});

it("updates review projections after a completed command without either timer", async () => {
	const stale = host.holdNextReply("refresh_thread_staleness");
	await host.emitRepoChanged({
		repo: "/repo",
		paths: [],
		command_completed: true,
	});
	await stale.entered;
	host.seedResponse("list_reviews", [{ ...review, title: "after" }]);
	stale.release(0);

	await waitFor(() => expect(manager.activeReview?.title).toBe("after"));
});

it("catches up a busy staleness read before projecting the completed command", async () => {
	const first = host.holdNextReply("refresh_thread_staleness");
	const second = host.holdNextReply("refresh_thread_staleness");
	await host.emitRepoChanged({
		repo: "/repo",
		paths: [],
		command_completed: true,
	});
	await first.entered;
	await host.emitRepoChanged({
		repo: "/repo",
		paths: [],
		command_completed: true,
	});
	first.release(0);
	await second.entered;
	host.seedResponse("list_reviews", [{ ...review, title: "latest" }]);
	second.release(0);

	await waitFor(() => expect(manager.activeReview?.title).toBe("latest"));
});
