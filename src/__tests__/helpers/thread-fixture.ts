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
		// What the wire sends for the default "open" state; a test overriding
		// `state` overrides this alongside it, as the backend would.
		allowed_transitions: ["done", "dismissed"],
		replies: [],
		...overrides,
	};
}

/**
 * A Thread pinned to a file's own content. `resolvedStartLine` is where the
 * backend last found the block and is the value the inline row renders at, so
 * every test states it; null is a block the file has lost, and also a row
 * written before Trunk stored the column, which is why it does not imply stale.
 */
export function aPinnedThread(props: {
	resolvedStartLine: number | null;
	id?: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
}): Thread {
	const id = props.id ?? "thread-1";
	const startLine = props.startLine ?? 1;

	return aThread({
		id,
		text: `pinned ${id}`,
		content_pin: {
			file_path: props.filePath ?? "src/main.ts",
			block: "pinned block",
			ordinal: 0,
			start_line: startLine,
			end_line: props.endLine ?? startLine,
		},
		resolved_start_line: props.resolvedStartLine,
	});
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
