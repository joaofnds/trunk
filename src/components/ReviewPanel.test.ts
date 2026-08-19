import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommentResolution,
	Review,
	SessionCommit,
	Thread,
} from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask` defaulting to false,
// @tauri-apps/api/event `listen`, etc.).
import "../__tests__/helpers/tauri-mock";

// Command-aware safeInvoke dispatcher: the panel issues one read and several
// writes, so a sequential mock would be fragile — route by command name.
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

vi.mock("../lib/toast.svelte.js", () => ({
	showToast: vi.fn(),
}));

// Copy handler writes to the clipboard via the plugin's writeText.
// Mock the boundary so we can assert on calls and trigger rejections.
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const commits: SessionCommit[] = [
	{
		oid: COMMIT_A,
		short_oid: "aaaaaaa",
		summary: "first commit",
		is_snapshot: false,
	},
	{
		oid: COMMIT_B,
		short_oid: "bbbbbbb",
		summary: "second commit",
		is_snapshot: false,
	},
];

function lineAnchoredComment(
	id: string,
	commitOid: string,
	text: string,
): Thread {
	return aThread({
		id,
		text,
		anchor: {
			commit_oid: commitOid,
			file_path: "src/main.ts",
			source: "Diff",
			side: "New",
			start_line: 10,
			end_line: 12,
		},
		cached_excerpt: "const x = 1;",
	});
}

function commitLevelComment(
	id: string,
	commitOid: string,
	text: string,
): Thread {
	return aThread({ id, text, commit_oid: commitOid });
}

function resolvable(id: string): CommentResolution {
	return { id, resolvable: true, reason: null };
}

function orphan(
	id: string,
	reason: CommentResolution["reason"],
): CommentResolution {
	return { id, resolvable: false, reason };
}

const ACTIVE_REVIEW = "REVIEW01";

function aReview(overrides: Partial<Review> = {}): Review {
	return {
		id: ACTIVE_REVIEW,
		title: "Review 2026-08-12 · REVIEW01",
		state: "composing",
		published: false,
		thread_count: 0,
		created_at: 0,
		...overrides,
	};
}

// Seed both owners of what the panel shows: the store contents go into the Fake
// manager (already refreshed, as RepoView's rune is by the time the panel
// mounts), and the panel's own resolve_threads read plus every write goes
// through the safeInvoke dispatcher. `generateDoc` routes the
// generate_review_doc IPC to a fixture string.
function installReads(opts: {
	commits?: SessionCommit[];
	comments?: Thread[];
	reviews?: Review[];
	activeReviewId?: string | null;
	resolutions?: CommentResolution[];
	generateDoc?: string;
	publishRejection?: unknown;
	generateRejection?: unknown;
}) {
	const comments = opts.comments ?? [];
	reviewComments.seed({
		commits: opts.commits ?? [],
		threads: comments,
		reviews: opts.reviews ?? [aReview({ thread_count: comments.length })],
		activeReviewId:
			opts.activeReviewId === undefined ? ACTIVE_REVIEW : opts.activeReviewId,
	});
	reviewComments.refresh();

	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
		switch (cmd) {
			case "resolve_threads":
				return Promise.resolve(opts.resolutions ?? []);
			case "generate_review_doc":
				if (opts.generateRejection !== undefined) {
					return Promise.reject(opts.generateRejection);
				}
				return Promise.resolve(opts.generateDoc ?? "# stub\n");
			case "publish_review":
				if (opts.publishRejection !== undefined) {
					return Promise.reject(opts.publishRejection);
				}
				return Promise.resolve(undefined);
			default:
				return Promise.resolve(undefined);
		}
	});
}

async function flush() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

function calledCommands(): string[] {
	return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
}

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

// The session owner the panel renders from. One instance for the file, reset
// per test; `installReads` seeds it alongside the safeInvoke dispatcher.
const reviewComments = createFakeReviewComments();

beforeEach(() => {
	vi.clearAllMocks();
	reviewComments.reset();
});

describe("ReviewPanel", () => {
	it("renders the commit groups the session owner reports", async () => {
		reviewComments.seed({
			commits,
			reviews: [aReview()],
			activeReviewId: ACTIVE_REVIEW,
		});
		await reviewComments.refresh();
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
		expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
	});

	it("groups comments under their commit headers", async () => {
		installReads({
			commits,
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "note on A"),
				commitLevelComment("c2", COMMIT_B, "note on B"),
			],
			resolutions: [resolvable("c1"), resolvable("c2")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Group headers: short SHA of each commit present.
		expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
		expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
		// Comments nested under their commit.
		expect(screen.getByText("note on A")).toBeInTheDocument();
		expect(screen.getByText("note on B")).toBeInTheDocument();
	});

	it("counts a lone comment and commit in the singular", async () => {
		installReads({
			commits: commits.slice(0, 1),
			comments: [lineAnchoredComment("c1", COMMIT_A, "note on A")],
			resolutions: [resolvable("c1")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("1 comment · 1 commit")).toBeInTheDocument();
	});

	it("counts several comments and commits in the plural", async () => {
		installReads({
			commits,
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "note on A"),
				commitLevelComment("c2", COMMIT_B, "note on B"),
			],
			resolutions: [resolvable("c1"), resolvable("c2")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("2 comments · 2 commits")).toBeInTheDocument();
	});

	// 260531-l02d: an auto-added snapshot with no comments is noise — hide it. An empty
	// hand-picked commit stays so its per-commit "Add note" affordance remains.
	it("hides empty snapshot sections but keeps empty hand-picked sections", async () => {
		installReads({
			commits: [
				{
					oid: COMMIT_A,
					short_oid: "aaaaaaa",
					summary: "Uncommitted changes — 1",
					is_snapshot: true,
				},
				{
					oid: COMMIT_B,
					short_oid: "bbbbbbb",
					summary: "hand-picked",
					is_snapshot: false,
				},
			],
			comments: [],
			resolutions: [],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Empty snapshot section hidden; empty hand-picked section shown.
		expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
		expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
	});

	it("reads the orphan resolutions on mount", async () => {
		installReads({ commits, comments: [], resolutions: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		expect(calledCommands()).toEqual(["resolve_threads"]);
	});

	it("shows the warm-with-commits empty state when commits exist but no comments", async () => {
		installReads({ commits, comments: [], resolutions: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		expect(screen.getByText("Review started.")).toBeInTheDocument();
	});

	it("shows the no-commits empty state when the session has no commits", async () => {
		installReads({ commits: [], comments: [], resolutions: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		expect(
			screen.getByText("No commits in this review yet."),
		).toBeInTheDocument();
	});

	// Regression: a comment whose anchor.commit_oid is not in session.commits
	// (e.g. user commented from a diff without marking the commit "in review"
	// via the graph) must still render in a fallback group — the resolver, not
	// the session list, is the truth about whether the commit is gone.
	it("renders fallback group for comments whose commit isn't in session.commits", async () => {
		installReads({
			commits: [],
			comments: [lineAnchoredComment("c1", COMMIT_A, "i need eyes on this")],
			resolutions: [resolvable("c1")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		expect(screen.getByText("i need eyes on this")).toBeInTheDocument();
		// Fallback header uses the short oid; no synthetic "(commit gone)" label
		// when the resolver says the comment is resolvable.
		expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
		expect(screen.queryByText("(commit gone)")).not.toBeInTheDocument();
		// The no-commits empty state must NOT fire when comments exist.
		expect(
			screen.queryByText("No commits in this review yet."),
		).not.toBeInTheDocument();
	});

	describe("add note", () => {
		it("writes a commit-level comment via add_commit_thread on Save", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			// Open the inline composer for commit A.
			const addBtns = screen.getAllByText("Add note");
			await fireEvent.click(addBtns[0]);
			await tick();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "a fresh note" } });
			await tick();

			await fireEvent.click(screen.getByText("Save"));
			await flush();

			expect(calledCommands()).toContain("add_commit_thread");
			const args = callArgs("add_commit_thread");
			expect(args?.commitOid).toBe(COMMIT_A);
			expect(args?.text).toBe("a fresh note");
		});

		it("disables Save while the add-note textarea is empty/whitespace", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			const addBtns = screen.getAllByText("Add note");
			await fireEvent.click(addBtns[0]);
			await tick();

			const saveBtn = screen.getByText("Save").closest("button");
			expect(saveBtn).toBeDisabled();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "   " } });
			await tick();
			expect(saveBtn).toBeDisabled();

			await fireEvent.input(textarea, { target: { value: "real" } });
			await tick();
			expect(saveBtn).not.toBeDisabled();
		});
	});

	describe("inline edit", () => {
		it("invokes edit_thread with the id and new text on Save", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "original")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();

			// The card also renders its own reply composer textarea; the edit
			// textarea is the first — it seeds from the comment's text, the
			// composer starts empty.
			const textarea = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
			expect(textarea.value).toBe("original");
			await fireEvent.input(textarea, { target: { value: "edited text" } });
			await tick();

			await fireEvent.click(screen.getByText("Save"));
			await flush();

			expect(calledCommands()).toContain("edit_thread");
			const args = callArgs("edit_thread");
			expect(args?.id).toBe("c1");
			expect(args?.text).toBe("edited text");
		});

		it("disables Save when the edit textarea is empty/whitespace", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "original")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();

			const textarea = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "  " } });
			await tick();

			expect(screen.getByText("Save").closest("button")).toBeDisabled();
		});

		it("Cancel closes the editor without invoking edit_thread", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "original")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();
			await fireEvent.click(screen.getByText("Cancel"));
			await flush();

			expect(calledCommands()).not.toContain("edit_thread");
			expect(screen.getByText("original")).toBeInTheDocument();
		});
	});

	describe("delete", () => {
		it("does not invoke delete_thread when the confirm is cancelled", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(false);
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "doomed")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Delete"));
			await flush();

			expect(vi.mocked(ask)).toHaveBeenCalledTimes(1);
			expect(calledCommands()).not.toContain("delete_thread");
		});

		it("invokes delete_thread by id when the confirm is accepted", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "doomed")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Delete"));
			await flush();

			expect(calledCommands()).toContain("delete_thread");
			expect(callArgs("delete_thread")?.id).toBe("c1");
		});
	});

	describe("jump vs orphan", () => {
		it("calls onJump for a resolvable line-anchored comment", async () => {
			const onJump = vi.fn();
			const comment = lineAnchoredComment("c1", COMMIT_A, "jump me");
			installReads({
				commits,
				comments: [comment],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump,
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByLabelText("Jump to code"));
			await flush();

			expect(onJump).toHaveBeenCalledTimes(1);
			expect(onJump.mock.calls[0][0].id).toBe("c1");
		});

		it("renders an orphaned comment read-only with a reason badge and no jump", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "stale note")],
				resolutions: [orphan("c1", "FileGone")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			// Reason badge with the LOCKED label.
			expect(screen.getByText("file gone")).toBeInTheDocument();
			// Jump affordance is gone (or disabled) for an orphan.
			expect(screen.queryByLabelText("Jump to code")).toBeNull();
			// The comment text + excerpt remain visible.
			expect(screen.getByText("stale note")).toBeInTheDocument();
		});

		// resolve_threads walks a blob per comment, so it is the read
		// most likely to resolve out of order.
		it("keeps the newest resolutions when an older read resolves last", async () => {
			const older = Promise.withResolvers<CommentResolution[]>();
			const newer = Promise.withResolvers<CommentResolution[]>();
			const staged = [older.promise, newer.promise];
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "stale note")],
			});
			vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
				cmd === "resolve_threads"
					? (staged.shift() ?? Promise.resolve([]))
					: Promise.resolve(undefined),
			);
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			reviewComments.refresh();
			await flush();
			newer.resolve([orphan("c1", "FileGone")]);
			await flush();
			older.resolve([resolvable("c1")]);
			await flush();

			expect(screen.getByText("file gone")).toBeInTheDocument();
			expect(screen.queryByLabelText("Jump to code")).toBeNull();
		});

		it("clicking the commit summary calls onJumpToCommit with the full oid", async () => {
			const onJumpToCommit = vi.fn();
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "note")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit,
				},
			});
			await flush();

			await fireEvent.click(
				screen.getByLabelText(`Jump to commit ${commits[0].short_oid}`),
			);
			await flush();

			expect(onJumpToCommit).toHaveBeenCalledTimes(1);
			expect(onJumpToCommit).toHaveBeenCalledWith(COMMIT_A);
		});

		it("clicking the commit short oid copies the full oid", async () => {
			vi.mocked(writeText).mockClear();
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "note")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(
				screen.getByLabelText(`Copy SHA ${commits[0].short_oid}`),
			);
			await flush();

			expect(vi.mocked(writeText)).toHaveBeenCalledWith(COMMIT_A);
		});

		it("orders commit-level comments before line-anchored within the same commit group", async () => {
			installReads({
				commits: [commits[0]],
				comments: [
					lineAnchoredComment("L1", COMMIT_A, "line note one"),
					commitLevelComment("C1", COMMIT_A, "commit note one"),
					lineAnchoredComment("L2", COMMIT_A, "line note two"),
					commitLevelComment("C2", COMMIT_A, "commit note two"),
				],
				resolutions: [
					resolvable("L1"),
					resolvable("C1"),
					resolvable("L2"),
					resolvable("C2"),
				],
			});
			const { container } = render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			const order = Array.from(
				container.querySelectorAll(".comment-card-text"),
			).map((el) => el.textContent);
			// Both commit-level first (capture-order stable), then both line-anchored.
			expect(order).toEqual([
				"commit note one",
				"commit note two",
				"line note one",
				"line note two",
			]);
		});

		it("classifies diff-source excerpt lines by their +/-/space prefix", async () => {
			const commentWithDiff: Thread = aThread({
				id: "c1",
				text: "look at this",
				anchor: {
					commit_oid: COMMIT_A,
					file_path: "src/main.ts",
					source: "Diff",
					side: "New",
					start_line: 10,
					end_line: 12,
				},
				cached_excerpt:
					" const ctx = 0;\n+const added = 1;\n-const removed = 2;",
				commit_oid: null,
			});
			installReads({
				commits,
				comments: [commentWithDiff],
				resolutions: [resolvable("c1")],
			});
			const { container } = render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			const addedRow = screen
				.getByText("const added = 1;")
				.closest(".diff-line");
			const removedRow = screen
				.getByText("const removed = 2;")
				.closest(".diff-line");
			const contextRow = screen
				.getByText("const ctx = 0;")
				.closest(".diff-line");
			expect(addedRow?.className).toContain("diff-line-add");
			expect(removedRow?.className).toContain("diff-line-del");
			expect(contextRow?.className).toContain("diff-line-context");
			// The gutter character is in its own span so copy-paste of the content
			// doesn't include the +/-.
			expect(container.querySelectorAll(".diff-gutter").length).toBe(3);
		});

		it("maps each OrphanReason to its locked badge label", async () => {
			installReads({
				commits,
				comments: [
					lineAnchoredComment("c1", COMMIT_A, "a"),
					lineAnchoredComment("c2", COMMIT_A, "b"),
					commitLevelComment("c3", COMMIT_B, "c"),
				],
				resolutions: [
					orphan("c1", "CommitGone"),
					orphan("c2", "LineOutOfRange"),
					orphan("c3", "FileGone"),
				],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			expect(screen.getByText("commit gone")).toBeInTheDocument();
			expect(screen.getByText("line out of range")).toBeInTheDocument();
			expect(screen.getByText("file gone")).toBeInTheDocument();
		});
	});

	// Phase 72: Copy button replaces Generate. Click invokes generate_review_doc,
	// then writeText with the returned markdown; ✓ Copied for 1500ms with
	// clearTimeout-before-setTimeout re-arm; failure surfaces toast via
	// instanceof Error narrowing.
	describe("Copy", () => {
		// Scope fake timers to THIS describe only. The file-global `flush` helper
		// at the top uses `setTimeout(r, 0)` which deadlocks under fake timers —
		// the tests inside this block use a local `flushFake` instead.
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		// Microtask flush — safe under fake timers (no setTimeout(0)).
		async function flushFake() {
			await Promise.resolve();
			await tick();
		}

		// `Copy` vs `Copied` share only the `Cop` prefix (no `y` in `Copied`!) —
		// substring match on `/Copy/` would NOT match the success-state button.
		// Use `/Cop(y|ied)/` to cover both states via a single accessor.
		function getCopyButton() {
			return screen.getByRole("button", { name: /^Cop(y|ied)$/ });
		}

		function renderWithComment(
			opts: { generateDoc?: string; generateRejection?: unknown } = {},
		) {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "look here")],
				resolutions: [resolvable("c1")],
				generateDoc: opts.generateDoc ?? "the doc",
				generateRejection: opts.generateRejection,
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
		}

		it("Copy button is disabled when no comments", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flushFake();

			const copyBtn = getCopyButton();
			expect(copyBtn).toBeDisabled();
			// The disabled tooltip is inherited verbatim from the Generate button.
			expect(copyBtn.getAttribute("title")).toBe(
				"Add at least one comment to generate",
			);
		});

		it("copy click invokes generate and writeText", async () => {
			renderWithComment();
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();

			expect(calledCommands()).toContain("generate_review_doc");
			expect(callArgs("generate_review_doc")?.path).toBe("/repo");
			expect(vi.mocked(writeText)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(writeText)).toHaveBeenCalledWith("the doc");
		});

		it("shows Copied affordance", async () => {
			renderWithComment();
			await flushFake();
			// Before the click the button reads "Copy".
			expect(
				screen.getByRole("button", { name: /^Cop(y|ied)$/ }),
			).toHaveTextContent(/^Copy$/);
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(screen.getByRole("button", { name: /Copied/ })).toHaveTextContent(
				/Copied/,
			);
		});

		it("reverts to Copy after 1500ms", async () => {
			renderWithComment();
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(screen.getByRole("button", { name: /Copied/ })).toHaveTextContent(
				/Copied/,
			);
			vi.advanceTimersByTime(1500);
			await tick();
			expect(
				screen.getByRole("button", { name: /^Cop(y|ied)$/ }),
			).toHaveTextContent(/^Copy$/);
		});

		it("remains clickable during window", async () => {
			renderWithComment();
			await flushFake();
			// First click at virtual t=0.
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(screen.getByRole("button", { name: /Copied/ })).toHaveTextContent(
				/Copied/,
			);

			// Mid-window second click at virtual t=500.
			vi.advanceTimersByTime(500);
			await fireEvent.click(getCopyButton());
			await flushFake();

			// If the FIRST timer were still alive it would fire at t=1500
			// (we're at t=500 + 1499 = t=1999). Advance 1499 and assert still Copied.
			vi.advanceTimersByTime(1499);
			await tick();
			expect(screen.getByRole("button", { name: /Copied/ })).toHaveTextContent(
				/Copied/,
			);

			// Second timer fires at t=500 + 1500 = t=2000.
			vi.advanceTimersByTime(1);
			await tick();
			expect(
				screen.getByRole("button", { name: /^Cop(y|ied)$/ }),
			).toHaveTextContent(/^Copy$/);
		});

		it("shows error toast on failure", async () => {
			vi.mocked(writeText).mockRejectedValueOnce(new Error("plugin disabled"));
			renderWithComment();
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				"Failed to copy: plugin disabled",
				"error",
			);
		});

		it("does not flip copied on failure", async () => {
			vi.mocked(writeText).mockRejectedValueOnce(new Error("plugin disabled"));
			renderWithComment();
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();
			// Button text must still be Copy — never Copied — on the failure path.
			expect(
				screen.getByRole("button", { name: /^Cop(y|ied)$/ }),
			).toHaveTextContent(/^Copy$/);
			expect(
				screen.queryByRole("button", { name: /Copied/ }),
			).not.toBeInTheDocument();
		});

		it("surfaces the message when generate rejects with a TrunkError", async () => {
			renderWithComment({
				generateRejection: {
					code: "no_comments",
					message: "No comments to include",
				},
			});
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				"Failed to copy: No comments to include",
				"error",
			);
		});

		it("coerces non-Error rejection", async () => {
			vi.mocked(writeText).mockRejectedValueOnce("raw string");
			renderWithComment();
			await flushFake();
			await fireEvent.click(getCopyButton());
			await flushFake();
			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				"Failed to copy: raw string",
				"error",
			);
		});
	});
});

// Ending a review publishes it. FAKE timers here, which is why these tests use
// the local `flushFake` rather than the file-global `flush()` — the latter is
// setTimeout(0)-based and deadlocks under them.
describe("End review", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Microtask flush — safe under fake timers (no setTimeout(0)).
	async function flushFake() {
		await Promise.resolve();
		await tick();
	}

	// Render helper mirroring renderWithComment in the Copy describe. Returns
	// the full render() handle so tests that need the unmount() callback
	// (Test 6) can destructure it; Tests 1–5 ignore the return value.
	function renderWithSession() {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
		});
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
	}

	function endCallCount(): number {
		return calledCommands().filter((c) => c === "publish_review").length;
	}

	function getEndButton() {
		// Idle label is "End review"; confirming label is "Click again to confirm".
		// Both share no common substring with "End review", so use a regex union.
		return screen.getByRole("button", {
			name: /End review|Click again to confirm/,
		});
	}

	it("first click enters confirming state without invoking publish_review", async () => {
		renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();

		expect(getEndButton()).toHaveTextContent(/Click again to confirm/);
		expect(endCallCount()).toBe(0);
	});

	it("second click publishes the active review exactly once", async () => {
		renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();
		await fireEvent.click(getEndButton());
		await flushFake();

		expect(endCallCount()).toBe(1);
		expect(callArgs("publish_review")).toEqual({
			path: "/repo",
			reviewId: ACTIVE_REVIEW,
		});
		// Success path: no error toast.
		const errorCalls = vi
			.mocked(showToast)
			.mock.calls.filter((c) => c[1] === "error");
		expect(errorCalls.length).toBe(0);
	});

	it("auto-reverts to idle after 3000ms with no second click", async () => {
		renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();
		expect(getEndButton()).toHaveTextContent(/Click again to confirm/);

		vi.advanceTimersByTime(3000);
		await tick();

		expect(getEndButton()).toHaveTextContent(/^End review$/);
		expect(endCallCount()).toBe(0);
	});

	it("second click within window cancels the auto-revert timer (clearTimeout before setTimeout)", async () => {
		renderWithSession();
		await flushFake();

		// First click at virtual t=0 — arm the 3000ms revert.
		await fireEvent.click(getEndButton());
		await flushFake();
		expect(getEndButton()).toHaveTextContent(/Click again to confirm/);

		// Second click at virtual t=2000 — should clear the t=0+3000 revert AND
		// fire the IPC. Under mocked listen() the post-success reviews-changed
		// reload never happens, so the button stays in the confirming label —
		// proving the original revert timer was cancelled.
		vi.advanceTimersByTime(2000);
		await fireEvent.click(getEndButton());
		await flushFake();

		// Now at virtual t=2000 + IPC await. Advance another 1500ms — past
		// the original t=3000 revert deadline. If the timer hadn't been cleared
		// the button would have reverted to "End review" by now.
		vi.advanceTimersByTime(1500);
		await tick();

		expect(endCallCount()).toBe(1);
		expect(getEndButton()).not.toHaveTextContent(/^End review$/);
	});

	it("surfaces a publish-failure toast when publish_review rejects", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
			publishRejection: {
				code: "no_session",
				message: "No active review session",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();
		await fireEvent.click(getEndButton());
		await flushFake();

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"Failed to publish review: No active review session",
			"error",
		);
		expect(endCallCount()).toBe(1);
		// Arrays untouched on failure — comment text remains rendered (D-08).
		expect(screen.getByText("x")).toBeInTheDocument();
	});

	it("clears pending timer on unmount (no console.error from torn-down state)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const { unmount } = renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();
		expect(getEndButton()).toHaveTextContent(/Click again to confirm/);

		unmount();
		vi.advanceTimersByTime(3000);
		await Promise.resolve();

		expect(consoleError.mock.calls.length).toBe(0);
		consoleError.mockRestore();
	});
});

// Phase 73-03 — Empty-state branching. Three mutually exclusive empty states
// gated on the lifecycle rune + groups + comments arity:
//   no reviews at all                → cold ("No reviews yet")
//   a review, no commits, no threads → warm-no-commits (existing copy preserved)
//   a review with commits, no threads → warm-with-commits ("Review started.")
// REAL timers — these tests use the file-global `flush()` (setTimeout(r,0) + tick).
// Criterion 2 (list half) and criterion 3 (one-step switch). The panel shows a
// review list at the top and, below it, the threads of the ACTIVE review;
// selecting a row makes it active, which IS the switch.
describe("review list", () => {
	const READY: Review = {
		id: "READYRV1",
		title: "Auth review",
		state: "ready",
		published: true,
		thread_count: 2,
		created_at: 0,
	};

	function renderPanel() {
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
	}

	it("lists reviews with their derived state, short id and title", async () => {
		installReads({
			reviews: [aReview(), READY],
			activeReviewId: ACTIVE_REVIEW,
		});
		renderPanel();
		await flush();

		expect(screen.getByText("Auth review")).toBeInTheDocument();
		expect(screen.getByText(READY.id)).toBeInTheDocument();
		expect(screen.getByText(/ready · 2/)).toBeInTheDocument();
		expect(screen.getByText(/composing · 0/)).toBeInTheDocument();
	});

	it("marks the active review, and only it, as current", async () => {
		installReads({
			reviews: [aReview(), READY],
			activeReviewId: ACTIVE_REVIEW,
		});
		renderPanel();
		await flush();

		expect(
			screen.getByRole("button", { name: `Activate review ${ACTIVE_REVIEW}` }),
		).toHaveAttribute("aria-current", "true");
		expect(
			screen.getByRole("button", { name: `Activate review ${READY.id}` }),
		).not.toHaveAttribute("aria-current");
	});

	it("activating a review invokes set_active_review with its id", async () => {
		installReads({
			reviews: [aReview(), READY],
			activeReviewId: ACTIVE_REVIEW,
		});
		renderPanel();
		await flush();

		await fireEvent.click(
			screen.getByRole("button", { name: `Activate review ${READY.id}` }),
		);
		await flush();

		expect(callArgs("set_active_review")).toEqual({
			path: "/repo",
			reviewId: READY.id,
		});
	});

	it("does not re-activate the review that is already active", async () => {
		installReads({ reviews: [aReview()], activeReviewId: ACTIVE_REVIEW });
		renderPanel();
		await flush();

		await fireEvent.click(
			screen.getByRole("button", { name: `Activate review ${ACTIVE_REVIEW}` }),
		);
		await flush();

		expect(calledCommands()).not.toContain("set_active_review");
	});

	it("deleting a review takes a second click to confirm", async () => {
		installReads({ reviews: [aReview()], activeReviewId: ACTIVE_REVIEW });
		renderPanel();
		await flush();

		const del = screen.getByRole("button", {
			name: `Delete review ${ACTIVE_REVIEW}`,
		});
		await fireEvent.click(del);
		await flush();
		expect(calledCommands()).not.toContain("delete_review");

		await fireEvent.click(del);
		await flush();
		expect(callArgs("delete_review")).toEqual({
			path: "/repo",
			reviewId: ACTIVE_REVIEW,
		});
	});

	it("renames a review through the inline title editor", async () => {
		installReads({ reviews: [aReview()], activeReviewId: ACTIVE_REVIEW });
		renderPanel();
		await flush();

		await fireEvent.dblClick(
			screen.getByRole("button", { name: `Activate review ${ACTIVE_REVIEW}` }),
		);
		await tick();
		const input = screen.getByLabelText("Review title") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Renamed" } });
		await fireEvent.blur(input);
		await flush();

		expect(callArgs("rename_review")).toEqual({
			path: "/repo",
			reviewId: ACTIVE_REVIEW,
			title: "Renamed",
		});
	});
});

describe("empty states", () => {
	it("renders the cold empty state for a repo with no reviews", async () => {
		installReads({
			commits: [],
			comments: [],
			resolutions: [],
			reviews: [],
			activeReviewId: null,
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("No reviews yet")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Comment on a diff line to start one, or create an empty review above.",
			),
		).toBeInTheDocument();
		// Warm copy and prior "No comments yet" must NOT be visible in the cold branch.
		expect(screen.queryByText("Review started.")).toBeNull();
		expect(screen.queryByText("No comments yet.")).toBeNull();
	});

	it("renders warm-with-commits empty state when session active and zero comments", async () => {
		installReads({
			commits,
			comments: [],
			resolutions: [],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("Review started.")).toBeInTheDocument();
		expect(
			screen.getByText("Select diff lines or add a commit note to comment."),
		).toBeInTheDocument();
		// Cold copy must NOT be visible when a session is active.
		expect(screen.queryByText("No active review")).toBeNull();
	});

	it("renders existing warm-no-commits empty state when session active and zero commits", async () => {
		installReads({
			commits: [],
			comments: [],
			resolutions: [],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(
			screen.getByText("No commits in this review yet."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Add commits from the graph to start reviewing."),
		).toBeInTheDocument();
	});
});

// Phase 73-03 — Session summary caption. `{N} comments · {M} commits` above the
// list whenever a review is active; hidden when the repo has none.
// The middle dot is U+00B7 (literal · character — NOT * or -).
describe("summary line", () => {
	it("renders session summary line when session active", async () => {
		installReads({
			commits,
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "x"),
				lineAnchoredComment("c2", COMMIT_A, "y"),
			],
			resolutions: [resolvable("c1"), resolvable("c2")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("2 comments · 2 commits")).toBeInTheDocument();
	});

	it("no summary line when cold", async () => {
		installReads({
			commits: [],
			comments: [],
			resolutions: [],
			reviews: [],
			activeReviewId: null,
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// The "comments · " substring is unique to the caption — it cannot appear
		// in the cold-state copy ("No active review" / "Toggle review mode…").
		expect(screen.queryByText(/comments · /)).toBeNull();
	});
});

// The panel is the app's only error surface for review reads. The owner is
// alive for every open tab, so it records the failure and says nothing;
// whoever is on screen does the telling.
describe("read failures", () => {
	it("toasts a read failure the session owner reports", async () => {
		installReads({ commits, comments: [] });
		reviewComments.seed({ lastError: "Repository is not open" });
		await reviewComments.refresh();
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		const errorToasts = vi
			.mocked(showToast)
			.mock.calls.filter((c) => c[1] === "error");
		expect(errorToasts).toHaveLength(1);
		expect(errorToasts[0][0]).toContain("Repository is not open");
	});

	it("says nothing when the owner reports no failure", async () => {
		installReads({ commits, comments: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(vi.mocked(showToast)).not.toHaveBeenCalled();
	});
});

// The panel is a {#if} sibling of DiffPanel, so every jump from the panel into
// a diff destroys it. list_session_commits takes its headers from the graph
// cache, so its answer changes on every commit, amend, rebase and checkout —
// and the owning rune only refreshes on reviews-changed, which none of those
// emit. Coming back has to re-ask.
describe("remount", () => {
	it("re-reads the session so a change made while it was gone is on screen", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "note")],
			resolutions: [resolvable("c1")],
		});
		const first = render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		expect(screen.getByText("first commit")).toBeInTheDocument();
		first.unmount();

		// The user amends the commit while a diff is up: the session still holds
		// it, but under a new oid and summary.
		reviewComments.seed({
			commits: [
				{
					oid: COMMIT_B,
					short_oid: "ccccccc",
					summary: "amended commit",
					is_snapshot: false,
				},
			],
		});
		const refreshesBefore = reviewComments.refreshCount;

		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("amended commit")).toBeInTheDocument();
		expect(screen.queryByText("first commit")).toBeNull();
		expect(reviewComments.refreshCount).toBe(refreshesBefore + 1);
	});
});

// Multi-tab coordination. Tab A's delete_review call emits reviews-changed; the
// owning rune refreshes and reports the review gone, and this panel follows it
// to the cold empty state. Publishing is NOT this case — publishing deletes
// nothing, so the panel keeps rendering the review. Filtering the event down to
// this repo is the rune's job, pinned in review-comments.svelte.test.ts.
describe("multi-tab coordination", () => {
	it("a review deleted in another tab empties the panel", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "tab-A note")],
			resolutions: [resolvable("c1")],
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Initial warm render: comment visible, End button visible.
		expect(screen.getByText("tab-A note")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /End review/ }),
		).toBeInTheDocument();

		// Tab A deletes the review: the rune's reviews-changed refresh lands an
		// empty store.
		reviewComments.seed({
			commits: [],
			threads: [],
			reviews: [],
			activeReviewId: null,
		});
		await reviewComments.refresh();
		await flush();

		// Cold empty state now visible; warm copy and prior comment gone; End
		// button hidden (no active review → the {#if} gate hides it).
		expect(screen.getByText("No reviews yet")).toBeInTheDocument();
		expect(screen.queryByText("tab-A note")).toBeNull();
		expect(screen.queryByText("Review started.")).toBeNull();
		expect(screen.queryByRole("button", { name: /End review/ })).toBeNull();
	});
});
