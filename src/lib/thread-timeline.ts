import type { Reply, StateChange, ThreadFollow, ThreadState } from "./types.js";

/** One entry under a thread's root comment: a reply, a move of its state, or
 *  its move onto the rewritten copy of its commit. */
export type TimelineEntry =
	| { readonly kind: "reply"; readonly key: string; readonly reply: Reply }
	| {
			readonly kind: "change";
			readonly key: string;
			readonly change: StateChange;
	  }
	| {
			readonly kind: "follow";
			readonly key: string;
			readonly follow: ThreadFollow;
	  };

/** What a change says it did, after its author's name. A move back to open
 *  reads as a reopen, since every thread starts open without a change. */
export const CHANGE_TEXT: Record<ThreadState, string> = {
	open: "reopened",
	addressed: "marked addressed",
	done: "marked done",
	dismissed: "dismissed",
};

/** Ties in one second go reply, then change, then follow: an agent replies
 *  with its fix and then claims it, and the rewrite that moves a thread comes
 *  after the commit it rewrote. */
const TIE_ORDER: Record<TimelineEntry["kind"], number> = {
	reply: 0,
	change: 1,
	follow: 2,
};

/** Replies, state changes and follows in the order they happened. */
export function threadTimeline(
	replies: readonly Reply[],
	history: readonly StateChange[],
	follows: readonly ThreadFollow[] = [],
): TimelineEntry[] {
	const entries: TimelineEntry[] = [
		...replies.map((reply) => ({
			kind: "reply" as const,
			key: reply.id,
			reply,
		})),
		...history.map((change, h) => ({
			kind: "change" as const,
			key: `change-${h}`,
			change,
		})),
		...follows.map((follow, f) => ({
			kind: "follow" as const,
			key: `follow-${f}`,
			follow,
		})),
	];

	return entries.sort(
		(a, b) =>
			happenedAt(a) - happenedAt(b) || TIE_ORDER[a.kind] - TIE_ORDER[b.kind],
	);
}

function happenedAt(entry: TimelineEntry): number {
	switch (entry.kind) {
		case "reply":
			return entry.reply.created_at;
		case "change":
			return entry.change.created_at;
		case "follow":
			return entry.follow.created_at;
	}
}
