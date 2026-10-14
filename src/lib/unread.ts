import type { Reply, Thread } from "./types.js";

/** An agent reply the app has not yet shown the user. */
export function isUnseenAgentReply(reply: Reply): boolean {
	return reply.channel === "agent" && !reply.seen;
}

export function unseenAgentReplies(thread: Thread): readonly Reply[] {
	return thread.replies.filter(isUnseenAgentReply);
}

/** A thread holding an agent reply the app has not shown the user yet. */
export function isUnread(thread: Thread): boolean {
	return unseenAgentReplies(thread).length > 0;
}
