import type { Reply, StateChange, ThreadState } from "./types.js";

/** One entry under a thread's root comment: a reply, or a move of its state. */
export type TimelineEntry =
	| { readonly kind: "reply"; readonly key: string; readonly reply: Reply }
	| {
			readonly kind: "change";
			readonly key: string;
			readonly change: StateChange;
	  };

/** What a change says it did, after its author's name. A move back to open
 *  reads as a reopen, since every thread starts open without a change. */
export const CHANGE_TEXT: Record<ThreadState, string> = {
	open: "reopened",
	addressed: "marked addressed",
	done: "marked done",
	dismissed: "dismissed",
};

/** Replies and state changes in the order they happened. A change written in
 *  the same second as a reply follows it, since an agent replies with its fix
 *  and then claims it. */
export function threadTimeline(
	replies: readonly Reply[],
	history: readonly StateChange[],
): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	let r = 0;
	let h = 0;
	while (r < replies.length || h < history.length) {
		const reply = replies[r];
		const change = history[h];
		if (
			change === undefined ||
			(reply !== undefined && reply.created_at <= change.created_at)
		) {
			entries.push({ kind: "reply", key: reply.id, reply });
			r++;
		} else {
			entries.push({ kind: "change", key: `change-${h}`, change });
			h++;
		}
	}
	return entries;
}
