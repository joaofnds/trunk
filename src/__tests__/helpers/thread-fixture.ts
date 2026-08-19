import type { Reply, Thread } from "../../lib/types.js";

/**
 * A Thread with the fields every stored thread carries filled in, so a test
 * states only what it is about. A test exercising a non-default state,
 * channel, or reply list passes it explicitly.
 */
export function aThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: "thread-1",
		review_id: "REVIEW01",
		text: "",
		anchor: null,
		cached_excerpt: null,
		commit_oid: null,
		state: "open",
		stale: false,
		channel: "human",
		published: false,
		replies: [],
		...overrides,
	};
}

export function aReply(overrides: Partial<Reply> = {}): Reply {
	return {
		id: "reply-1",
		text: "",
		text_html: "",
		channel: "human",
		created_at: 1_000,
		...overrides,
	};
}
