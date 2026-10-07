import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	aReply,
	aStateChange,
	aThread,
} from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { createThreadEditorSession } from "../lib/review-editors.svelte.js";
import type { Anchor, Thread, ThreadState } from "../lib/types.js";
import ThreadCard from "./ThreadCard.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask`, defaulting to false).
import "../__tests__/helpers/tauri-mock";
import { REVIEWER } from "../lib/reviewer.svelte.js";

// review-comment-actions.ts is owned code (a thin wrapper over safeInvoke), so
// this asserts on safeInvoke, the real IPC boundary, matching the pattern used
// for the same wiring in ReviewPanel.test.ts, CommitDetail.test.ts, and the
// three diff-host test files.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(),
	};
});

function calledCommands(): string[] {
	return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
}

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

// The delete-confirmation flow awaits a dynamic `import()` before calling `ask`;
// a plain `fireEvent.click` doesn't wait for that microtask to settle.
async function expandCard() {
	const expand = screen.queryByRole("button", { name: "Expand thread" });
	if (expand) await fireEvent.click(expand);
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await tick();
}

describe("ThreadCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(safeInvoke).mockResolvedValue(undefined);
	});

	const anchor: Anchor = {
		commit_oid: "abc123",
		file_path: "src/foo.ts",
		source: "Diff",
		side: "New",
		start_line: 10,
		end_line: 11,
	};
	const comment: Thread = aThread({
		id: "c1",
		text: "needs a null check here",
		anchor,
		cached_excerpt: "+const x = 2;\n const y = 3;",
		commit_oid: "abc123",
	});

	function renderCard(
		overrides: Partial<ComponentProps<typeof ThreadCard>> = {},
	) {
		return render(ThreadCard, {
			props: {
				thread: comment,
				repoPath: "/repo",
				onedit: () => {},
				ondelete: () => {},
				...overrides,
			},
		});
	}

	const currentFileComment: Thread = aThread({
		id: "c2",
		text: "this constant needs a name",
		anchor: null,
		cached_excerpt: "const answer = 42;",
		content_pin: {
			file_path: "src/untouched.ts",
			block: "const answer = 42;",
			ordinal: 0,
			start_line: 1,
			end_line: 1,
		},
	});

	it("locates a current-file comment by its pin, which carries no anchor", () => {
		const { container } = renderCard({ thread: currentFileComment });

		expect(container.querySelector(".comment-card-fileref")).toHaveTextContent(
			"src/untouched.ts:L1-L1",
		);
	});

	it("locates it at the line the backend last resolved the block to", () => {
		const { container } = renderCard({
			thread: { ...currentFileComment, resolved_start_line: 7 },
		});

		expect(container.querySelector(".comment-card-fileref")).toHaveTextContent(
			"src/untouched.ts:L7-L7",
		);
	});

	describe("scoped under its file", () => {
		it("names the range of lines it is on", () => {
			renderCard({ scoped: true });

			expect(screen.getByText("Lines 10–11")).toBeInTheDocument();
			expect(screen.queryByText("src/foo.ts")).not.toBeInTheDocument();
		});

		it("titles its range with the file and lines it points at", () => {
			renderCard({ scoped: true, jumpable: true, onjump: () => {} });

			expect(
				screen.getByRole("button", { name: "Lines 10–11" }),
			).toHaveAttribute("title", "src/foo.ts:L10-L11");
		});

		it("names a single line", () => {
			renderCard({
				scoped: true,
				thread: { ...comment, anchor: { ...anchor, end_line: 10 } },
			});

			expect(screen.getByText("Line 10")).toBeInTheDocument();
		});

		it("names a note on the whole commit", () => {
			renderCard({
				scoped: true,
				thread: { ...comment, anchor: null, cached_excerpt: null },
			});

			expect(screen.getByText("Whole commit")).toBeInTheDocument();
		});

		it("opens the code of a current-file comment at its lines", async () => {
			const jumped: Thread[] = [];
			renderCard({
				scoped: true,
				thread: currentFileComment,
				jumpable: true,
				onjump: (thread) => jumped.push(thread),
			});

			await fireEvent.click(screen.getByRole("button", { name: "Line 1" }));

			expect(jumped.map((t) => t.id)).toEqual(["c2"]);
		});

		it("refuses to open the code of an orphaned comment", () => {
			renderCard({
				scoped: true,
				jumpable: true,
				onjump: () => {},
				orphaned: true,
				orphanLabel: "commit gone",
			});

			expect(
				screen.getByRole("button", { name: "Lines 10–11" }),
			).toBeDisabled();
		});
	});

	describe("flags", () => {
		it("marks an orphaned comment and says why", () => {
			renderCard({ orphaned: true, orphanLabel: "commit gone" });

			expect(
				screen.getByTitle("Commit gone. Only the saved excerpt survives."),
			).toHaveTextContent("Orphaned");
		});

		it("notes over the excerpt that an orphaned comment's code is gone", () => {
			renderCard({ orphaned: true, orphanLabel: "commit gone" });

			expect(
				screen.getByText("Saved excerpt. Commit gone."),
			).toBeInTheDocument();
		});

		it("notes over the excerpt that a stale comment's lines moved", () => {
			renderCard({ thread: { ...comment, stale: true } });

			expect(
				screen.getByText(
					"Saved excerpt. These lines have moved or changed since.",
				),
			).toBeInTheDocument();
		});
	});

	it.each<ThreadState>(["open", "addressed", "done", "dismissed"])(
		"shows the stale marker exactly while the backend marks a %s thread stale",
		async (state) => {
			const view = renderCard({
				thread: { ...comment, state, stale: false },
			});

			expect(screen.queryByText("Stale")).not.toBeInTheDocument();

			await view.rerender({
				thread: { ...comment, state, stale: true },
				repoPath: "/repo",
				onedit: () => {},
				ondelete: () => {},
			});
			expect(screen.getByText("Stale")).toBeInTheDocument();
			expect(
				view.container.querySelector(".orphan-badge"),
			).not.toBeInTheDocument();

			await view.rerender({
				thread: { ...comment, state, stale: false },
				repoPath: "/repo",
				onedit: () => {},
				ondelete: () => {},
			});
			expect(screen.queryByText("Stale")).not.toBeInTheDocument();
		},
	);

	/// A stale current-file thread points at code that is gone, so the excerpt is
	/// the only place its subject survives.
	it("still shows the excerpt of a stale current-file comment", () => {
		renderCard({
			thread: { ...currentFileComment, stale: true },
			orphaned: true,
			orphanLabel: "code gone",
		});

		expect(screen.getByText("const answer = 42;")).toBeTruthy();
		expect(screen.getByText("Saved excerpt. Code gone.")).toBeTruthy();
		expect(screen.getByText("Stale")).toBeTruthy();
	});

	it("keeps the comment body and excerpt code selectable while the gutter stays unselectable", () => {
		const { container } = renderCard();

		expect(screen.getByText(comment.text)).toHaveClass("select-text");
		expect(screen.getByText("const x = 2;")).toHaveClass("select-text");

		const gutter = container.querySelector(".diff-gutter") as HTMLElement;
		expect(gutter).toHaveClass("select-none");
		expect(gutter).not.toHaveClass("select-text");
	});

	it("renders the backend-provided markdown HTML and keeps select-text inline", () => {
		const md: Thread = {
			...comment,
			text: "**bold** body",
			text_html: "<p><strong>bold</strong> body</p>",
		};
		const { container } = renderCard({ thread: md });

		const body = container.querySelector(".comment-card-text") as HTMLElement;
		expect(body.querySelector("strong")?.textContent).toBe("bold");
		// select-text must stay INLINE on the wrapper (jsdom only reads inline
		// styles; a scoped class wouldn't unit-assert).
		expect(body).toHaveClass("select-text");
	});

	it("falls back to raw text when no rendered HTML is present", () => {
		const { container } = renderCard();
		const body = container.querySelector(".comment-card-text") as HTMLElement;
		expect(body.tagName).toBe("SPAN");
		expect(body.textContent).toBe(comment.text);
	});

	it("renders a reply with its attribution", () => {
		const withReply: Thread = {
			...comment,
			replies: [
				aReply({
					id: "r1",
					text: "fixed",
					text_html: "<p>fixed</p>",
					channel: "agent",
				}),
			],
		};

		renderCard({ thread: withReply });

		expect(screen.getByText("fixed")).toBeInTheDocument();
		expect(screen.getByText("Agent")).toBeInTheDocument();
		expect(screen.getByText("via trunk CLI")).toBeInTheDocument();
	});

	it("attributes a human reply to you", () => {
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", channel: "human" })],
		};

		renderCard({ thread: withReply });

		expect(screen.getAllByText("You")).toHaveLength(2);
	});

	it("attributes a human root comment to you", () => {
		renderCard();

		expect(screen.getByText("You")).toBeInTheDocument();
	});

	it("attributes an agent root comment to the agent", () => {
		// Agent-originated roots are spec-deferred (every root is `human` in
		// practice today), so this overrides the fixture to cover the gap while
		// it's cheap, ahead of that channel shipping.
		renderCard({ thread: { ...comment, channel: "agent" } });

		expect(screen.getByText("Agent")).toBeInTheDocument();
	});

	describe("age", () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("says how long ago the root comment was written", () => {
			const twoDaysAgo = Date.parse("2026-10-04T11:00:00Z") / 1000;

			renderCard({ thread: { ...comment, created_at: twoDaysAgo } });

			expect(screen.getByText("2d")).toBeInTheDocument();
		});
	});

	it("colours the excerpt's code by the spans the backend sends", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				cached_excerpt: "+let x",
				excerpt_spans: [
					[
						{
							start: 0,
							end: 3,
							syntax_class: "syn-keyword",
							emphasized: false,
						},
						{ start: 3, end: 6, syntax_class: "", emphasized: false },
					],
				],
			},
		});

		expect(
			container.querySelector(".comment-card-diff .syn-keyword"),
		).toHaveTextContent("let");
	});

	it("keeps each span on its own code once the excerpt is dedented", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				cached_excerpt: "+  let x",
				excerpt_spans: [
					[
						{ start: 0, end: 2, syntax_class: "", emphasized: false },
						{
							start: 2,
							end: 5,
							syntax_class: "syn-keyword",
							emphasized: false,
						},
						{ start: 5, end: 7, syntax_class: "", emphasized: false },
					],
				],
			},
		});

		expect(
			container.querySelector(".comment-card-diff .syn-keyword"),
		).toHaveTextContent(/^let$/);
		expect(
			container.querySelector(".comment-card-diff .diff-content"),
		).toHaveTextContent(/^let x$/);
	});

	it("dedents the excerpt to its least indented line", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				cached_excerpt: "+\t\tif (x) {\n \t\t\treturn;\n \t\t}",
			},
		});

		const code = Array.from(
			container.querySelectorAll(".comment-card-diff .diff-content"),
		).map((n) => n.textContent);
		expect(code).toEqual(["if (x) {", "\treturn;", "}"]);
	});

	it("dims the excerpt of a stale thread", () => {
		const { container } = renderCard({ thread: { ...comment, stale: true } });

		expect(container.querySelector(".comment-card-diff")).toHaveClass(
			"comment-card-diff-dim",
		);
	});

	it("numbers the excerpt's lines from the anchored start line", () => {
		const { container } = renderCard();

		const numbers = Array.from(
			container.querySelectorAll(".comment-card-diff .diff-number"),
		).map((n) => n.textContent);
		expect(numbers).toEqual(["10", "11"]);
	});

	it("leaves the other side's lines unnumbered", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				anchor: { ...anchor, end_line: 10 },
				cached_excerpt: "-const x = 1;\n+const x = 2;",
			},
		});

		const numbers = Array.from(
			container.querySelectorAll(".comment-card-diff .diff-number"),
		).map((n) => n.textContent);
		expect(numbers).toEqual(["", "10"]);
	});

	function excerptNumbers(container: HTMLElement): (string | null)[] {
		return Array.from(
			container.querySelectorAll(".comment-card-diff .diff-number"),
		).map((n) => n.textContent);
	}

	it("numbers a context line before the first changed line from the range", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				anchor: { ...anchor, start_line: 3, end_line: 3 },
				cached_excerpt: "-old\n b\n+new",
			},
		});

		expect(excerptNumbers(container)).toEqual(["", "2", "3"]);
	});

	it("numbers an old-side excerpt by the old file's lines", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				anchor: {
					...anchor,
					side: "Old",
					start_line: 10,
					end_line: 10,
				},
				cached_excerpt: "-a\n+b\n c",
			},
		});

		expect(excerptNumbers(container)).toEqual(["10", "", "11"]);
	});

	it("numbers a full-file excerpt across its unchanged-lines gap", () => {
		const { container } = renderCard({
			thread: {
				...comment,
				anchor: {
					...anchor,
					source: "FullFile",
					start_line: 10,
					end_line: 14,
				},
				cached_excerpt: "a\n\u2026 3 lines unchanged \u2026\nb",
			},
		});

		expect(excerptNumbers(container)).toEqual(["10", "", "14"]);
	});

	// An inline card's height is measured once from a hidden copy, so a card
	// that changed its own height would leave the diff's rows misplaced.
	it("offers no collapse inside the diff", () => {
		renderCard({ variant: "inline" });

		expect(
			screen.queryByRole("button", { name: "Collapse thread" }),
		).not.toBeInTheDocument();
	});

	describe("inside the diff", () => {
		it("names its lines and its review, since the diff shows the file", () => {
			renderCard({ variant: "inline" });

			const header = screen.getByRole("banner");

			expect(screen.getByTitle("src/foo.ts:L10-L11")).toHaveTextContent(
				"L10-L11",
			);
			expect(header).toHaveTextContent(comment.review_id);
			expect(header).not.toHaveTextContent("src/foo.ts");
		});

		it("sets its review quieter than its lines, as plain text", () => {
			renderCard({ variant: "inline" });

			const review = screen.getByTitle(`Review ${comment.review_id}`);
			expect(review).toHaveClass("text-text-subtle");
			expect(review.tagName).toBe("SPAN");
			expect(review).not.toHaveClass("border");
		});

		// With no toggle to open it, a folded card would hide its replies and
		// its Reopen for good.
		it.each(["done", "dismissed"] as const)(
			"keeps a %s thread open, since it has nothing to expand it",
			(state) => {
				renderCard({
					variant: "inline",
					thread: { ...comment, state, allowed_transitions: ["open"] },
				});

				expect(
					screen.getByRole("button", { name: "Reopen" }),
				).toBeInTheDocument();
			},
		);

		it("leaves out the excerpt, since the code sits right above it", () => {
			renderCard({ variant: "inline" });

			expect(screen.queryByText("const x = 2;")).not.toBeInTheDocument();
		});
	});

	it("collapses to its header", async () => {
		renderCard();

		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse thread" }),
		);

		expect(
			screen.queryByRole("textbox", { name: "Reply" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Expand thread" }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it.each(["done", "dismissed"] as const)(
		"starts a %s thread collapsed",
		(state) => {
			renderCard({
				thread: { ...comment, state, allowed_transitions: ["open"] },
			});

			expect(
				screen.getByRole("button", { name: "Expand thread" }),
			).toHaveAttribute("aria-expanded", "false");
		},
	);

	it("collapses a thread once it is resolved", async () => {
		const { rerender } = renderCard();

		await rerender({
			thread: { ...comment, state: "done", allowed_transitions: ["open"] },
		});

		expect(
			screen.getByRole("button", { name: "Expand thread" }),
		).toBeInTheDocument();
	});

	it("peeks the comment's plain text while collapsed", async () => {
		renderCard({
			thread: { ...comment, text: "needs a `null` check\n\nhere" },
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse thread" }),
		);

		expect(screen.getByText("needs a null check here")).toBeInTheDocument();
	});

	it("counts the replies while collapsed", async () => {
		renderCard({
			thread: {
				...comment,
				replies: [aReply({ id: "r1" }), aReply({ id: "r2" })],
			},
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse thread" }),
		);

		expect(screen.getByText("2 replies")).toBeInTheDocument();
	});

	it("sums up its latest state change in the header, open or not", async () => {
		const { container } = renderCard({
			thread: {
				...comment,
				state: "addressed",
				replies: [aReply({ id: "r1" })],
				history: [
					aStateChange({ state: "addressed", channel: "agent" }),
					aStateChange({ state: "open", channel: "human" }),
					aStateChange({ state: "addressed", channel: "agent" }),
				],
			},
		});
		const header = () => container.querySelector(".comment-card-header");

		expect(header()).toHaveTextContent(/Agent marked addressed · /);
		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse thread" }),
		);
		expect(header()).toHaveTextContent(/Agent marked addressed · /);
		expect(header()).not.toHaveTextContent("1 reply");
	});

	it("tells its state changes among the replies", () => {
		renderCard({
			thread: {
				...comment,
				history: [aStateChange({ state: "done", channel: "human" })],
			},
		});

		expect(screen.getByText("marked done")).toBeInTheDocument();
	});

	it("collapses to the last three replies", () => {
		const fiveReplies: Thread = {
			...comment,
			replies: [1, 2, 3, 4, 5].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: fiveReplies });

		expect(screen.queryByText("reply 1")).not.toBeInTheDocument();
		expect(screen.queryByText("reply 2")).not.toBeInTheDocument();
		expect(screen.getByText("reply 3")).toBeInTheDocument();
		expect(screen.getByText("reply 4")).toBeInTheDocument();
		expect(screen.getByText("reply 5")).toBeInTheDocument();
	});

	it("reveals the hidden replies on click", async () => {
		const fiveReplies: Thread = {
			...comment,
			replies: [1, 2, 3, 4, 5].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: fiveReplies });

		await fireEvent.click(screen.getByText("Show 2 more replies"));

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(screen.getByText("reply 2")).toBeInTheDocument();
	});

	it("shows every reply with no expand control when there are four or fewer", () => {
		const threeReplies: Thread = {
			...comment,
			replies: [1, 2, 3, 4].map((n) =>
				aReply({
					id: `r${n}`,
					text: `reply ${n}`,
					text_html: `<p>reply ${n}</p>`,
				}),
			),
		};

		renderCard({ thread: threeReplies });

		expect(screen.getByText("reply 1")).toBeInTheDocument();
		expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
	});

	it("shows the thread's current state in a chip", () => {
		const dismissed: Thread = { ...comment, state: "dismissed" };

		renderCard({ thread: dismissed });

		expect(screen.getByText("Dismissed")).toBeInTheDocument();
	});

	it("puts the thread's state actions in its header", () => {
		renderCard();

		const markDone = screen.getByRole("button", { name: "Mark done" });

		expect(markDone.closest("header")).not.toBeNull();
	});

	it.each(["Edit comment", "Delete comment"])(
		"draws %s on the comment's author line, as a reply draws its own",
		(name) => {
			renderCard({ thread: comment });

			const action = screen.getByRole("button", { name });

			expect(action.closest("header")).toBeNull();
			expect(action.closest(".thread-message")).toHaveTextContent(comment.text);
		},
	);

	const THREAD_ACTIONS = '[aria-label="Thread actions"] button';

	function stateActionLabels(container: HTMLElement) {
		return Array.from(container.querySelectorAll(THREAD_ACTIONS)).map((b) =>
			b.textContent?.trim(),
		);
	}

	// Each row mirrors what the wire sends for that state (the backend's
	// human-channel allowed_transitions, in wire order) and pins the label and
	// order per target. The set itself is the backend's; the wording, the order
	// and what an unsettled thread leaves out are the card's.
	it.each([
		{
			state: "open" as const,
			allowed: ["done", "dismissed"] as const,
			labels: ["Dismiss", "Mark done"],
		},
		{
			state: "addressed" as const,
			allowed: ["done", "dismissed", "open"] as const,
			labels: ["Dismiss", "Mark done"],
		},
		{ state: "done" as const, allowed: ["open"] as const, labels: ["Reopen"] },
		{
			state: "dismissed" as const,
			allowed: ["open"] as const,
			labels: ["Reopen"],
		},
	])(
		"offers $labels for a $state thread",
		async ({ state, allowed, labels }) => {
			const { container } = renderCard({
				thread: { ...comment, state, allowed_transitions: [...allowed] },
			});
			await expandCard();

			expect(stateActionLabels(container)).toEqual(labels);
		},
	);

	it("keeps Delete comment quiet until it is pointed at", () => {
		renderCard({ thread: comment });

		const remove = screen.getByRole("button", { name: "Delete comment" });
		expect(remove).toHaveClass("text-text-subtle", "hover:text-danger");
		expect(remove).not.toHaveClass("text-danger");
	});

	it("rests its reply field on one line with the thread's actions in sight", () => {
		renderCard({ thread: comment });

		expect(screen.getByRole("textbox", { name: "Reply" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Mark done" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("renders its state actions from allowed_transitions, not from the state", async () => {
		// A list the matrix would never pair with "done": a local switch on the
		// state would offer Reopen and this expectation would fail.
		const mismatched: Thread = {
			...comment,
			state: "done",
			allowed_transitions: ["done", "dismissed"],
		};

		const { container } = renderCard({ thread: mismatched });
		await expandCard();

		expect(stateActionLabels(container)).toEqual(["Dismiss", "Mark done"]);
	});

	it("calls setThreadState with the repo path and target state when Mark done is clicked", async () => {
		renderCard();

		await fireEvent.click(screen.getByText("Mark done"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "done",
		});
	});

	it("calls setThreadState with the repo path and target state when Dismiss is clicked", async () => {
		renderCard();

		await fireEvent.click(screen.getByText("Dismiss"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "dismissed",
		});
	});

	it("calls setThreadState with the repo path and target state when Reopen is clicked", async () => {
		const done: Thread = {
			...comment,
			state: "done",
			allowed_transitions: ["open"],
		};
		renderCard({ thread: done });
		await expandCard();

		await fireEvent.click(screen.getByText("Reopen"));

		expect(calledCommands()).toContain("set_thread_state");
		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "open",
		});
	});

	it("marks an addressed thread done", async () => {
		renderCard({
			thread: {
				...comment,
				state: "addressed",
				allowed_transitions: ["done", "dismissed", "open"],
			},
		});

		await fireEvent.click(screen.getByText("Mark done"));

		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "c1",
			next: "done",
		});
	});

	it("seeds the reply editor with the reply's text", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		renderCard({ thread: humanReply });

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));

		const textarea = screen.getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		expect(textarea.value).toBe("original");
	});

	it("keeps root and reply drafts when the card remounts", async () => {
		const editorSession = createThreadEditorSession();
		const first = renderCard({ editorSession });

		await fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
		await fireEvent.input(screen.getAllByRole("textbox")[0], {
			target: { value: "unfinished root" },
		});
		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "unfinished reply" },
		});
		first.unmount();

		renderCard({ editorSession });

		expect(screen.getAllByRole("textbox")[0]).toHaveValue("unfinished root");
		expect(screen.getByLabelText("Reply")).toHaveValue("unfinished reply");
	});

	it("keeps an active reply edit when the card remounts", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		const editorSession = createThreadEditorSession();
		const first = renderCard({ thread: humanReply, editorSession });

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
		await fireEvent.input(screen.getByRole("textbox", { name: "Edit reply" }), {
			target: { value: "unfinished reply edit" },
		});
		first.unmount();

		renderCard({ thread: humanReply, editorSession });

		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"unfinished reply edit",
		);
	});

	it("calls editReply with the repo path, reply id, and new text", async () => {
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		renderCard({ thread: humanReply });

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
		const textarea = screen.getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "corrected" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(calledCommands()).toContain("edit_reply");
		expect(callArgs("edit_reply")).toEqual({
			path: "/repo",
			id: "r1",
			text: "corrected",
		});
	});

	it("keeps an edited reply when editReply is refused", async () => {
		vi.mocked(safeInvoke).mockRejectedValueOnce({
			code: "sqlite",
			message: "database is locked",
		});
		const humanReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "original", channel: "human" })],
		};
		renderCard({ thread: humanReply });

		await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
		const textarea = screen.getByRole("textbox", {
			name: "Edit reply",
		}) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "keep this edit" } });
		await fireEvent.click(screen.getByText("Save"));
		await flush();

		expect(screen.getByRole("textbox", { name: "Edit reply" })).toHaveValue(
			"keep this edit",
		);
	});

	it("sends the typed reply on Cmd+Enter", async () => {
		renderCard();

		const field = screen.getByLabelText("Reply") as HTMLTextAreaElement;
		await fireEvent.input(field, { target: { value: "on it" } });
		await fireEvent.keyDown(field, { key: "Enter", metaKey: true });

		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "c1",
			text: "on it",
			delivery: "send",
		});
	});

	it("sends the typed reply from its Reply button", async () => {
		renderCard();

		const field = screen.getByLabelText("Reply") as HTMLInputElement;
		await fireEvent.input(field, { target: { value: "on it" } });
		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));

		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "c1",
			text: "on it",
			delivery: "send",
		});
	});

	it("offers no Reply button before anything is typed", () => {
		renderCard();

		expect(
			screen.queryByRole("button", { name: "Reply" }),
		).not.toBeInTheDocument();
	});

	it("holds a reply in a new batch from Start a batch", async () => {
		renderCard();
		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "on it" },
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Start a batch" }),
		);

		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "c1",
			text: "on it",
			delivery: "hold",
		});
	});

	describe("when its review holds a batch", () => {
		const batched = { ...comment, batch_held: true };

		it("adds a reply to the batch instead of sending it", async () => {
			renderCard({ thread: batched });
			await fireEvent.input(screen.getByLabelText("Reply"), {
				target: { value: "on it" },
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Add to batch" }),
			);

			expect(callArgs("add_reply")).toEqual({
				path: "/repo",
				threadId: "c1",
				text: "on it",
				delivery: "hold",
			});
		});

		it("offers no way to send a reply alone", async () => {
			renderCard({ thread: batched });

			await fireEvent.input(screen.getByLabelText("Reply"), {
				target: { value: "on it" },
			});

			expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
			expect(
				screen.queryByRole("button", { name: "Start a batch" }),
			).toBeNull();
		});
	});

	it("marks a held comment Pending", () => {
		renderCard({ thread: { ...comment, pending: true, batch_held: true } });

		expect(screen.getByText("Pending")).toBeInTheDocument();
	});

	it("marks only the held reply Pending", () => {
		renderCard({
			thread: {
				...comment,
				batch_held: true,
				replies: [
					aReply({ id: "r1", text_html: "<p>sent</p>", pending: false }),
					aReply({ id: "r2", text_html: "<p>held</p>", pending: true }),
				],
			},
		});

		const pending = screen.getAllByText("Pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.closest(".thread-reply")).toHaveTextContent("held");
	});

	it("marks nothing Pending once its batch is sent", () => {
		renderCard({
			thread: { ...comment, replies: [aReply({ id: "r1", text: "sent" })] },
		});

		expect(screen.queryByText("Pending")).toBeNull();
	});

	it("submits the typed reply via addReply with the repo path and clears the composer", async () => {
		renderCard();

		const textarea = screen.getByLabelText("Reply") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "sounds good" } });
		await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

		expect(calledCommands()).toContain("add_reply");
		expect(callArgs("add_reply")).toEqual({
			path: "/repo",
			threadId: "c1",
			text: "sounds good",
			delivery: "send",
		});
		expect(textarea.value).toBe("");
	});

	it("keeps a typed reply when addReply is refused", async () => {
		vi.mocked(safeInvoke).mockRejectedValueOnce({
			code: "sqlite",
			message: "database is locked",
		});
		renderCard();

		const textarea = screen.getByLabelText("Reply") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "keep this reply" } });
		await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
		await flush();

		expect(textarea).toHaveValue("keep this reply");
	});

	it("does not clear a replacement reply draft when the first save resolves", async () => {
		let settleFirst!: () => void;
		vi.mocked(safeInvoke).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				settleFirst = resolve;
			}),
		);
		const firstSession = createThreadEditorSession();
		const replacementSession = createThreadEditorSession();
		const view = renderCard({ editorSession: firstSession });

		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "reply for first card" },
		});
		await fireEvent.keyDown(screen.getByLabelText("Reply"), {
			key: "Enter",
			metaKey: true,
		});

		await view.rerender({
			thread: comment,
			repoPath: "/repo",
			onedit: () => {},
			ondelete: () => {},
			editorSession: replacementSession,
		});
		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "reply for replacement card" },
		});

		settleFirst();
		await flush();
		expect(screen.getByLabelText("Reply")).toHaveValue(
			"reply for replacement card",
		);

		await view.rerender({
			thread: comment,
			repoPath: "/repo",
			onedit: () => {},
			ondelete: () => {},
			editorSession: firstSession,
		});
		await fireEvent.input(screen.getByLabelText("Reply"), {
			target: { value: "reply after the first save" },
		});
		expect(screen.getByLabelText("Reply")).toBeEnabled();
	});

	it("does not offer Edit for an agent reply", () => {
		const agentReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		renderCard({ thread: agentReply });

		expect(
			screen.queryByRole("button", { name: "Edit reply" }),
		).not.toBeInTheDocument();
	});

	it("offers Delete for every reply and calls deleteReply with the repo path and id once confirmed", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(true);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		renderCard({ thread: withReply });

		await fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));
		await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(calledCommands()).toContain("delete_reply"));

		expect(ask).toHaveBeenCalledTimes(1);
		expect(calledCommands()).toContain("delete_reply");
		expect(callArgs("delete_reply")).toEqual({ path: "/repo", id: "r1" });
	});

	it("does not call deleteReply when the reply-delete confirmation is cancelled", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValue(false);
		const withReply: Thread = {
			...comment,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};
		renderCard({ thread: withReply });

		await fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));
		await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

		expect(ask).toHaveBeenCalledTimes(1);
		expect(calledCommands()).not.toContain("delete_reply");
	});

	it("offers Delete for a thread the agent can already read", () => {
		renderCard({ thread: { ...comment, pending: false } });

		expect(
			screen.getByRole("button", { name: "Delete comment" }),
		).toBeInTheDocument();
	});

	describe("deleting the thread", () => {
		it("keeps the delete in sight beside the edit without waiting for the pointer", () => {
			renderCard();

			const remove = screen.getByRole("button", { name: "Delete comment" });

			expect(remove.closest(".opacity-0")).toBeNull();
		});

		it("asks in the card before deleting", async () => {
			const deleted: string[] = [];
			renderCard({ ondelete: (id) => deleted.push(id) });

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);

			expect(
				screen.getByText(
					"Delete this thread and its replies? This cannot be undone.",
				),
			).toBeInTheDocument();
			expect(deleted).toEqual([]);
		});

		it("deletes once the reviewer confirms", async () => {
			const deleted: string[] = [];
			renderCard({ ondelete: (id) => deleted.push(id) });

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

			expect(deleted).toEqual(["c1"]);
		});

		it("keeps the thread when the reviewer cancels", async () => {
			const deleted: string[] = [];
			renderCard({ ondelete: (id) => deleted.push(id) });

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			expect(deleted).toEqual([]);
			expect(
				screen.queryByText(
					"Delete this thread and its replies? This cannot be undone.",
				),
			).not.toBeInTheDocument();
		});

		it("deletes at once where the host asks for no confirmation", async () => {
			const deleted: string[] = [];
			renderCard({
				confirmDelete: false,
				ondelete: (id) => deleted.push(id),
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);

			expect(deleted).toEqual(["c1"]);
		});
	});

	describe("editing the comment", () => {
		it("saves on Cmd-Enter", async () => {
			const edits: [string, string][] = [];
			renderCard({ onedit: (id, text) => edits.push([id, text]) });

			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
			const field = screen.getByLabelText("Edit comment");
			await fireEvent.input(field, { target: { value: "a sharper note" } });
			await fireEvent.keyDown(field, { key: "Enter", metaKey: true });

			expect(edits).toEqual([["c1", "a sharper note"]]);
		});

		it("cancels on Escape", async () => {
			const edits: [string, string][] = [];
			renderCard({ onedit: (id, text) => edits.push([id, text]) });

			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
			await fireEvent.keyDown(screen.getByLabelText("Edit comment"), {
				key: "Escape",
			});

			expect(edits).toEqual([]);
			expect(
				screen.queryByRole("textbox", { name: "Edit comment" }),
			).toBeNull();
		});
	});

	describe("avatars", () => {
		it("draws the agent as a prompt", () => {
			renderCard({ thread: { ...comment, channel: "agent" } });

			expect(screen.getByTitle("Agent (via trunk CLI)")).toHaveTextContent(
				">_",
			);
		});

		it("draws the reviewer as themselves", () => {
			renderCard();

			expect(screen.getByTitle("You")).toBeInTheDocument();
		});

		it("draws the reviewer by their initials once the repo names them", () => {
			render(ThreadCard, {
				props: {
					thread: comment,
					repoPath: "/repo",
					onedit: () => {},
					ondelete: () => {},
				},
				context: new Map([[REVIEWER, { initials: "JF" }]]),
			});

			expect(screen.getByTitle("You")).toHaveTextContent("JF");
		});
	});

	it("offers Delete reply on a reply the agent can already read", () => {
		const published: Thread = {
			...comment,
			pending: false,
			replies: [aReply({ id: "r1", text: "fixed", channel: "agent" })],
		};

		renderCard({ thread: published });

		expect(
			screen.getByRole("button", { name: "Delete reply" }),
		).toBeInTheDocument();
	});
});
