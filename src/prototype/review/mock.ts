// Mock data for the review prototype. The shapes are the prototype's own,
// smaller than the app's, so a design idea costs an edit here rather than a
// backend change. Times are seconds, counted back from when the page loaded.

import type {
	Channel,
	ReviewState,
	StateChange,
	ThreadState,
} from "../../lib/types.js";

const now = Math.floor(Date.now() / 1000);

function minutesAgo(minutes: number): number {
	return now - minutes * 60;
}

export interface Message {
	id: string;
	channel: Channel;
	text: string;
	createdAt: number;
}

export type ExcerptKind = "add" | "del" | "context";

export interface ExcerptLine {
	kind: ExcerptKind;
	number: number | null;
	content: string;
}

export type Scope =
	| { kind: "lines"; path: string; start: number; end: number }
	| { kind: "file"; path: string }
	| { kind: "commit" };

export interface Thread {
	id: string;
	state: ThreadState;
	stale: boolean;
	scope: Scope;
	excerpt: ExcerptLine[];
	/** The first message is the comment that opened the thread. */
	messages: Message[];
	history: StateChange[];
}

export type Target =
	| {
			kind: "commit";
			sha: string;
			summary: string;
			authoredAt: number;
	  }
	| { kind: "uncommitted" };

export interface Group {
	key: string;
	target: Target;
	threads: Thread[];
}

export interface Section {
	branch: string;
	checkedOut: boolean;
	lane: number;
	groups: Group[];
}

export interface Review {
	id: string;
	title: string;
	state: ReviewState;
	visibleToAgent: boolean;
	sections: Section[];
}

function change(
	state: ThreadState,
	channel: Channel,
	minutes: number,
	commit: string | null = null,
): StateChange {
	return { state, channel, commit, created_at: minutesAgo(minutes) };
}

const PRICING_EXCERPT: ExcerptLine[] = [
	{ kind: "context", number: 6, content: "def discount(total, code):" },
	{ kind: "add", number: 7, content: '    if code == "VIP":' },
	{ kind: "add", number: 8, content: "        return total * 0.5" },
	{ kind: "context", number: 9, content: "    return total" },
];

const RETRY_EXCERPT: ExcerptLine[] = [
	{ kind: "context", number: 41, content: "async function push(remote) {" },
	{ kind: "del", number: 42, content: "  return git.push(remote);" },
	{ kind: "add", number: 42, content: "  for (let i = 0; i < 5; i++) {" },
	{
		kind: "add",
		number: 43,
		content: "    try { return await git.push(remote); } catch {}",
	},
	{ kind: "add", number: 44, content: "  }" },
];

const WATCHER_EXCERPT: ExcerptLine[] = [
	{
		kind: "add",
		number: 118,
		content: "let debounce = Duration::from_millis(0);",
	},
];

export const reviews: Review[] = [
	{
		id: "FHT6H3B5",
		title: "Pricing and push retries",
		state: "open",
		visibleToAgent: true,
		sections: [
			{
				branch: "feature/pricing",
				checkedOut: true,
				lane: 0,
				groups: [
					{
						key: "uncommitted",
						target: { kind: "uncommitted" },
						threads: [
							{
								id: "t1",
								state: "open",
								stale: true,
								scope: {
									kind: "lines",
									path: "src/pricing.py",
									start: 7,
									end: 8,
								},
								excerpt: PRICING_EXCERPT,
								messages: [
									{
										id: "m1",
										channel: "human",
										text: "A 50% VIP discount stacks with nothing else, so drop it until pricing signs off.",
										createdAt: minutesAgo(13),
									},
									{
										id: "m2",
										channel: "agent",
										text: "Removed the VIP branch. The discount table is the only source of codes now.",
										createdAt: minutesAgo(11),
									},
									{
										id: "m3",
										channel: "human",
										text: "Thanks, the VIP branch is gone. Confirming once tests run.",
										createdAt: minutesAgo(9),
									},
								],
								history: [
									change("addressed", "agent", 11, "a3f9c21e0b8d"),
									change("done", "human", 8),
									change("open", "human", 8),
								],
							},
						],
					},
					{
						key: "c2",
						target: {
							kind: "commit",
							sha: "a3f9c21",
							summary: "Retry a rejected push before reporting it",
							authoredAt: minutesAgo(95),
						},
						threads: [
							{
								id: "t2",
								state: "addressed",
								stale: false,
								scope: {
									kind: "lines",
									path: "src/lib/push.ts",
									start: 42,
									end: 44,
								},
								excerpt: RETRY_EXCERPT,
								messages: [
									{
										id: "m4",
										channel: "human",
										text: "Five blind retries swallow the real error. Retry only on a non-fast-forward rejection, and surface anything else at once.",
										createdAt: minutesAgo(80),
									},
									{
										id: "m5",
										channel: "agent",
										text: "Now retries only when the remote rejects as non-fast-forward, and rethrows the first other error. Covered by `push.test.ts`.",
										createdAt: minutesAgo(40),
									},
								],
								history: [change("addressed", "agent", 40, "7c1e0d94b2aa")],
							},
							{
								id: "t3",
								state: "open",
								stale: false,
								scope: { kind: "commit" },
								excerpt: [],
								messages: [
									{
										id: "m6",
										channel: "human",
										text: "The subject says retry but the body never says why a push gets rejected here. Add the reason.",
										createdAt: minutesAgo(78),
									},
								],
								history: [],
							},
						],
					},
					{
						key: "c1",
						target: {
							kind: "commit",
							sha: "e41b07d",
							summary: "Watch the worktree without a debounce",
							authoredAt: minutesAgo(300),
						},
						threads: [
							{
								id: "t4",
								state: "done",
								stale: false,
								scope: {
									kind: "lines",
									path: "src-tauri/src/watcher.rs",
									start: 118,
									end: 118,
								},
								excerpt: WATCHER_EXCERPT,
								messages: [
									{
										id: "m7",
										channel: "human",
										text: "A zero debounce refreshes once per file during a checkout.",
										createdAt: minutesAgo(290),
									},
									{
										id: "m8",
										channel: "agent",
										text: "Set it to 150ms and coalesced the events per tick.",
										createdAt: minutesAgo(250),
									},
								],
								history: [
									change("addressed", "agent", 250, "0b77c3e1d5f2"),
									change("done", "human", 200),
								],
							},
							{
								id: "t5",
								state: "dismissed",
								stale: false,
								scope: { kind: "file", path: "src-tauri/src/watcher.rs" },
								excerpt: [],
								messages: [
									{
										id: "m9",
										channel: "human",
										text: "Rename this module to fs_events?",
										createdAt: minutesAgo(285),
									},
								],
								history: [change("dismissed", "human", 280)],
							},
						],
					},
				],
			},
		],
	},
	{
		id: "K2M9QX4T",
		title: "Graph lane colours",
		state: "settled",
		visibleToAgent: false,
		sections: [],
	},
];

/** The lines of the file the inline view draws, with the thread under line 8. */
export const inlineFile = {
	path: "src/pricing.py",
	threadAfterLine: 8,
	lines: [
		{ kind: "context", number: 1, content: "from decimal import Decimal" },
		{ kind: "context", number: 2, content: "" },
		{ kind: "context", number: 3, content: 'TAX = Decimal("0.2")' },
		{ kind: "context", number: 4, content: "" },
		{ kind: "context", number: 5, content: "" },
		{ kind: "context", number: 6, content: "def discount(total, code):" },
		{ kind: "add", number: 7, content: '    if code == "VIP":' },
		{ kind: "add", number: 8, content: "        return total * 0.5" },
		{ kind: "context", number: 9, content: "    return total" },
		{ kind: "context", number: 10, content: "" },
		{ kind: "context", number: 11, content: "def tax(total):" },
		{ kind: "context", number: 12, content: "    return total * TAX" },
	] satisfies ExcerptLine[],
};
