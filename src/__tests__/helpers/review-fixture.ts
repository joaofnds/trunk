import type { Review } from "../../lib/types.js";

/**
 * A Review as the list read returns it, so a test states only what it is
 * about: its title, whether it is archived, or what its threads add up to.
 */
export function aReview(overrides: Partial<Review> = {}): Review {
	return {
		id: "REVIEW01",
		title: "Review 2026-08-12",
		state: "settled",
		visible_to_agent: false,
		archived: false,
		thread_count: 0,
		unresolved_count: 0,
		pending_count: 0,
		created_at: 0,
		...overrides,
	};
}
