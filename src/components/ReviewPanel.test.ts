import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "../lib/invoke.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	Comment,
	CommentResolution,
	SessionCommit,
	SessionStatus,
} from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask` defaulting to false,
// @tauri-apps/api/event `listen`, etc.).
import "../__tests__/helpers/tauri-mock";

// Command-aware safeInvoke dispatcher: the panel issues three reads on mount
// (list_session_commits / list_session_comments / resolve_session_comments) via
// Promise.all, so a sequential mock would be fragile — route by command name.
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

// The panel registers a session-changed listener in an $effect; mock listen so
// it doesn't reach the real Tauri IPC core (which is undefined under jsdom).
// Capture the callback so tests can simulate cross-tab `session-changed` emits
// by calling `fireSessionChanged(path)` below — Plan 73-01 needs this for the
// cold-boot resume recursion-safety assertion (resume_review_session must fire
// exactly once across the initial reload + the listener-triggered reload).
let sessionChangedHandler: ((event: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((_event: string, cb: (event: { payload: string }) => void) => {
		sessionChangedHandler = cb;
		return Promise.resolve(() => {
			sessionChangedHandler = null;
		});
	}),
}));

function fireSessionChanged(payload: string): void {
	sessionChangedHandler?.({ payload });
}

// Phase 72: Copy handler writes to the clipboard via the plugin's writeText.
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
): Comment {
	return {
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
		commit_oid: null,
	};
}

function commitLevelComment(
	id: string,
	commitOid: string,
	text: string,
): Comment {
	return {
		id,
		text,
		anchor: null,
		cached_excerpt: null,
		commit_oid: commitOid,
	};
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

// Install the dispatcher: reads return the supplied fixtures; writes resolve
// undefined. Per-test overrides extend `extra`. `generateDoc` routes the Phase
// 70 generate_review_doc IPC to a fixture string (the safeInvoke wrapper
// returns it; the panel's rune-call then drives the preview swap).
function installReads(opts: {
	commits?: SessionCommit[];
	comments?: Comment[];
	resolutions?: CommentResolution[];
	generateDoc?: string;
	// Phase 73-01 — lifecycle dispatch. Default `status` is `active` so the ~50
	// pre-existing tests stay on the warm path (no cold-boot resume call).
	status?: SessionStatus;
	// After a successful resume_review_session call, subsequent
	// get_review_session_status reads return this — models the backend
	// transitioning "resume-available" -> "active" after a successful resume.
	// Used by the recursion-safety assertion in describe("cold-boot resume"):
	// the listener-triggered second reload reads "active" and skips the resume
	// branch, keeping the call count at exactly 1.
	statusAfterResume?: SessionStatus;
	statusRejection?: unknown;
	resumeRejection?: unknown;
	endRejection?: unknown;
	generateRejection?: unknown;
}) {
	const status: SessionStatus = opts.status ?? {
		state: "active",
		file_exists: true,
		canonical_path: "/repo",
	};
	let resumed = false;
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
		switch (cmd) {
			case "list_session_commits":
				return Promise.resolve(opts.commits ?? []);
			case "list_session_comments":
				return Promise.resolve(opts.comments ?? []);
			case "resolve_session_comments":
				return Promise.resolve(opts.resolutions ?? []);
			case "generate_review_doc":
				if (opts.generateRejection !== undefined) {
					return Promise.reject(opts.generateRejection);
				}
				return Promise.resolve(opts.generateDoc ?? "# stub\n");
			case "get_review_session_status":
				if (opts.statusRejection !== undefined) {
					return Promise.reject(opts.statusRejection);
				}
				return Promise.resolve(
					resumed ? (opts.statusAfterResume ?? status) : status,
				);
			case "resume_review_session":
				if (opts.resumeRejection !== undefined) {
					return Promise.reject(opts.resumeRejection);
				}
				resumed = true;
				return Promise.resolve(undefined);
			case "end_review_session":
				if (opts.endRejection !== undefined) {
					return Promise.reject(opts.endRejection);
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ReviewPanel", () => {
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
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Empty snapshot section hidden; empty hand-picked section shown.
		expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
		expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
	});

	it("reads the three session sources on mount", async () => {
		installReads({ commits, comments: [], resolutions: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();
		const cmds = calledCommands();
		expect(cmds).toContain("list_session_commits");
		expect(cmds).toContain("list_session_comments");
		expect(cmds).toContain("resolve_session_comments");
	});

	it("shows the warm-with-commits empty state when commits exist but no comments", async () => {
		installReads({ commits, comments: [], resolutions: [] });
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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
		it("writes a commit-level comment via add_commit_comment on Save", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
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

			expect(calledCommands()).toContain("add_commit_comment");
			const args = callArgs("add_commit_comment");
			expect(args?.commitOid).toBe(COMMIT_A);
			expect(args?.text).toBe("a fresh note");
		});

		it("disables Save while the add-note textarea is empty/whitespace", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
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
		it("invokes edit_comment with the id and new text on Save", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "original")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			expect(textarea.value).toBe("original");
			await fireEvent.input(textarea, { target: { value: "edited text" } });
			await tick();

			await fireEvent.click(screen.getByText("Save"));
			await flush();

			expect(calledCommands()).toContain("edit_comment");
			const args = callArgs("edit_comment");
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
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "  " } });
			await tick();

			expect(screen.getByText("Save").closest("button")).toBeDisabled();
		});

		it("Cancel closes the editor without invoking edit_comment", async () => {
			installReads({
				commits,
				comments: [lineAnchoredComment("c1", COMMIT_A, "original")],
				resolutions: [resolvable("c1")],
			});
			render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Edit"));
			await tick();
			await fireEvent.click(screen.getByText("Cancel"));
			await flush();

			expect(calledCommands()).not.toContain("edit_comment");
			expect(screen.getByText("original")).toBeInTheDocument();
		});
	});

	describe("delete", () => {
		it("does not invoke delete_comment when the confirm is cancelled", async () => {
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
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Delete"));
			await flush();

			expect(vi.mocked(ask)).toHaveBeenCalledTimes(1);
			expect(calledCommands()).not.toContain("delete_comment");
		});

		it("invokes delete_comment by id when the confirm is accepted", async () => {
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
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
			await flush();

			await fireEvent.click(screen.getByText("Delete"));
			await flush();

			expect(calledCommands()).toContain("delete_comment");
			expect(callArgs("delete_comment")?.id).toBe("c1");
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
			const commentWithDiff: Comment = {
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
			};
			installReads({
				commits,
				comments: [commentWithDiff],
				resolutions: [resolvable("c1")],
			});
			const { container } = render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
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

// Phase 73-01 — cold-boot resume. When the panel mounts on a repo whose review
// session exists on disk but isn't in memory (status.state === "resume-available"),
// reload() must call resume_review_session exactly once before the parallel list
// reads. Active/none paths must skip the resume entirely. Resume rejections (e.g.
// the newer_version TrunkError from a forward-incompat session file) surface as a
// toast via errorMessage(); reads still attempt and fall through the existing
// no_session arm to the cold empty state.
//
// REAL timers — the cold-boot reload chain is microtask-driven only. Do NOT
// promote vi.useFakeTimers() into this describe; the top-of-file `flush()` helper
// uses setTimeout(0) and deadlocks under fake timers.
describe("cold-boot resume", () => {
	const RESUME_AVAILABLE: SessionStatus = {
		state: "resume-available",
		file_exists: true,
		canonical_path: "/repo",
	};
	const ACTIVE: SessionStatus = {
		state: "active",
		file_exists: true,
		canonical_path: "/repo",
	};
	const NONE: SessionStatus = {
		state: "none",
		file_exists: false,
		canonical_path: "/repo",
	};

	function resumeCallCount(): number {
		return calledCommands().filter((c) => c === "resume_review_session").length;
	}

	it("calls resume_review_session exactly once when status is resume-available", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
			status: RESUME_AVAILABLE,
			// After a successful resume the backend reports "active"; the
			// session-changed listener triggers a second reload() which reads
			// "active" and SKIPS the resume branch — keeping the count at 1.
			statusAfterResume: ACTIVE,
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Fire the listener-triggered second reload (no ad-hoc mockImplementation;
		// the dispatcher's `resumed` flag is what gates the post-resume status).
		fireSessionChanged("/repo");
		await flush();

		expect(resumeCallCount()).toBe(1);

		// Resume happens BEFORE the parallel reads — assert call order from the
		// dispatcher's recorded sequence.
		const order = calledCommands();
		const resumeIdx = order.indexOf("resume_review_session");
		const listIdx = order.indexOf("list_session_commits");
		expect(resumeIdx).toBeGreaterThanOrEqual(0);
		expect(listIdx).toBeGreaterThan(resumeIdx);

		// Reads ran after resume — the comment text is in the DOM.
		expect(screen.getByText("x")).toBeInTheDocument();
	});

	it("skips resume when session is already active", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
			status: ACTIVE,
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(resumeCallCount()).toBe(0);
		// Reads still run.
		expect(screen.getByText("x")).toBeInTheDocument();
	});

	it("skips resume when no session exists on disk", async () => {
		installReads({
			commits: [],
			comments: [],
			resolutions: [],
			status: NONE,
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(resumeCallCount()).toBe(0);
		// Reads still run; no toast emitted; cold render path.
		expect(calledCommands()).toContain("list_session_commits");
		expect(vi.mocked(showToast)).not.toHaveBeenCalled();
	});

	it("surfaces newer_version TrunkError rejection as toast", async () => {
		installReads({
			status: RESUME_AVAILABLE,
			resumeRejection: {
				code: "newer_version",
				message: "Session file is newer than this build supports",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"Failed to resume review: Session file is newer than this build supports",
			"error",
		);
	});

	it("surfaces arbitrary IPC failure as toast via errorMessage Error branch", async () => {
		installReads({
			status: RESUME_AVAILABLE,
			resumeRejection: new Error("boom"),
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"Failed to resume review: boom",
			"error",
		);
	});
});

// Phase 73-02 — End-review affordance. Two-step inline confirmation on the panel
// header: first click flips label to "Click again to confirm" + danger color
// (3000ms auto-revert with rapid-reclick re-arm); second click within the window
// invokes end_review_session({ path: repoPath }). Failure path surfaces a toast
// via errorMessage(); arrays are NOT manually cleared (D-08 — the session-changed
// listener round-trip is the canonical refresh). Component unmount during the
// confirming window clears the pending timer ($effect teardown — Pitfall 3).
//
// FAKE timers — scoped to THIS describe only. The file-global `flush()` helper
// uses setTimeout(r, 0) and deadlocks under fake timers (same constraint as
// describe("Copy") above; the local flushFake is microtask-only).
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
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
		});
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
	}

	function endCallCount(): number {
		return calledCommands().filter((c) => c === "end_review_session").length;
	}

	function getEndButton() {
		// Idle label is "End review"; confirming label is "Click again to confirm".
		// Both share no common substring with "End review", so use a regex union.
		return screen.getByRole("button", {
			name: /End review|Click again to confirm/,
		});
	}

	it("first click enters confirming state without invoking end_review_session", async () => {
		renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();

		expect(getEndButton()).toHaveTextContent(/Click again to confirm/);
		expect(endCallCount()).toBe(0);
	});

	it("second click invokes end_review_session({ path }) exactly once", async () => {
		renderWithSession();
		await flushFake();

		await fireEvent.click(getEndButton());
		await flushFake();
		await fireEvent.click(getEndButton());
		await flushFake();

		expect(endCallCount()).toBe(1);
		expect(callArgs("end_review_session")).toEqual({ path: "/repo" });
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
		// fire the IPC. Under mocked listen() the post-success session-changed
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

	it("surfaces 'Failed to end review: …' toast on end_review_session rejection", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
			endRejection: {
				code: "no_session",
				message: "No active review session",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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
			"Failed to end review: No active review session",
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
//   sessionState === "none"                          → cold ("No active review")
//   sessionState !== "none" && groups.length === 0   → warm-no-commits (existing copy preserved)
//   sessionState !== "none" && !hasAnyComment        → warm-with-commits ("Review started.")
// REAL timers — these tests use the file-global `flush()` (setTimeout(r,0) + tick).
describe("empty states", () => {
	it("renders cold empty state when no session", async () => {
		installReads({
			commits: [],
			comments: [],
			resolutions: [],
			status: {
				state: "none",
				file_exists: false,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(screen.getByText("No active review")).toBeInTheDocument();
		expect(
			screen.getByText("Toggle review mode in the toolbar to start."),
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
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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
// list whenever sessionState !== "none"; hidden in the cold branch.
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
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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
			status: {
				state: "none",
				file_exists: false,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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

// Phase 73-03 — Multi-tab coordination (REQ-73-MULTITAB, D-09). Tab A's
// end_review_session call emits a session-changed event; tab B's existing
// listener at ReviewPanel.svelte:447-461 reloads, sees status='none', and
// renders the cold empty state. Cross-repo payloads are filtered by the
// listener's `canonicalPath && payload !== canonicalPath` check — no churn.
//
// REAL timers — the listener chain is microtask-driven. The captured
// `sessionChangedHandler` from the @tauri-apps/api/event mock is the simulator.
describe("multi-tab coordination", () => {
	it("End in another tab clears panel", async () => {
		// Swappable status: dispatcher reads the closure variable on every call,
		// so post-end mutation flips the next get_review_session_status to 'none'.
		let currentStatus: SessionStatus = {
			state: "active",
			file_exists: true,
			canonical_path: "/repo",
		};
		let currentCommits: SessionCommit[] = commits;
		let currentComments: Comment[] = [
			lineAnchoredComment("c1", COMMIT_A, "tab-A note"),
		];
		let currentResolutions: CommentResolution[] = [resolvable("c1")];

		vi.mocked(safeInvoke).mockReset();
		vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
			switch (cmd) {
				case "get_review_session_status":
					return Promise.resolve(currentStatus);
				case "list_session_commits":
					return Promise.resolve(currentCommits);
				case "list_session_comments":
					return Promise.resolve(currentComments);
				case "resolve_session_comments":
					return Promise.resolve(currentResolutions);
				default:
					return Promise.resolve(undefined);
			}
		});

		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
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

		// Simulate tab A ending the review: backend flips to 'none' and emits
		// session-changed for this canonical path. Tab B's listener fires
		// reload(), which re-reads the swapped status + empty arrays.
		currentStatus = {
			state: "none",
			file_exists: false,
			canonical_path: "/repo",
		};
		currentCommits = [];
		currentComments = [];
		currentResolutions = [];

		fireSessionChanged("/repo");
		await flush();

		// Cold empty state now visible; warm copy and prior comment gone; End
		// button hidden (sessionState === 'none' → {#if} gate hides it).
		expect(screen.getByText("No active review")).toBeInTheDocument();
		expect(screen.queryByText("tab-A note")).toBeNull();
		expect(screen.queryByText("Review started.")).toBeNull();
		expect(screen.queryByRole("button", { name: /End review/ })).toBeNull();
	});

	it("session-changed for different repo is filtered out", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "look here")],
			resolutions: [resolvable("c1")],
			status: {
				state: "active",
				file_exists: true,
				canonical_path: "/repo",
			},
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		// Capture call count AFTER the initial reload has set canonicalPath —
		// this is the precondition for the listener's payload filter to kick in.
		const initialCalls = vi.mocked(safeInvoke).mock.calls.length;

		fireSessionChanged("/different-repo");
		await flush();

		// Listener's `canonicalPath && event.payload !== canonicalPath` filter
		// short-circuits → reload() never fires → no additional IPC calls.
		expect(vi.mocked(safeInvoke).mock.calls.length).toBe(initialCalls);
		// And no churn that would clear the rendered comment.
		expect(screen.getByText("look here")).toBeInTheDocument();
	});

	it("session-changed is dropped while the canonical path is unknown", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "look here")],
			resolutions: [resolvable("c1")],
			statusRejection: { code: "not_open", message: "repo not open" },
		});
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		const initialCalls = vi.mocked(safeInvoke).mock.calls.length;

		fireSessionChanged("/some/other/repo");
		await flush();

		expect(vi.mocked(safeInvoke).mock.calls.length).toBe(initialCalls);
	});
});
