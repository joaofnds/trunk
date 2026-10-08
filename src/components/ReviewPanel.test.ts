import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { createReviewEditorStore } from "../lib/review-editors.svelte.js";
import { ALL_THREADS, THREAD_PRESETS } from "../lib/review-filter.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import { SHOW_DELAY_MS } from "../lib/tooltip.js";
import type {
	CommentResolution,
	RefLabel,
	Review,
	ReviewFilter,
	SessionCommit,
	Thread,
	ThreadFilter,
} from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";

// Shared Tauri mock (provides @tauri-apps/plugin-dialog `ask` defaulting to false,
// @tauri-apps/api/event `listen`, etc.).
import "../__tests__/helpers/tauri-mock";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";

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

// jsdom lays nothing out, so it has no scrollIntoView for the panel to call.
if (typeof Element.prototype.scrollIntoView === "undefined") {
	Element.prototype.scrollIntoView = () => {};
}

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const NEEDS_ME = THREAD_PRESETS[1].filter;
const SETTLED = THREAD_PRESETS[2].filter;

const commits: SessionCommit[] = [
	aSessionCommit({
		oid: COMMIT_A,
		short_oid: "aaaaaaa",
		summary: "first commit",
	}),
	aSessionCommit({
		oid: COMMIT_B,
		short_oid: "bbbbbbb",
		summary: "second commit",
	}),
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

function currentFileComment(id: string, text: string): Thread {
	return aThread({
		id,
		text,
		anchor: null,
		content_pin: {
			file_path: "src/untouched.ts",
			block: "const answer = 42;",
			ordinal: 0,
			start_line: 4,
			end_line: 4,
		},
		cached_excerpt: "const answer = 42;",
	});
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
	sendRejection?: unknown;
	generateRejection?: unknown;
	otherReviews?: Record<
		string,
		{ threads: Thread[]; commits: SessionCommit[] }
	>;
}) {
	const comments = opts.comments ?? [];
	reviewComments.seed({
		commits: opts.commits ?? [],
		threads: comments,
		otherReviews: opts.otherReviews ?? {},
		reviews: opts.reviews ?? [
			aReview({
				thread_count: comments.length,
				pending_count: comments.length,
			}),
		],
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
			case "send_review":
				if (opts.sendRejection !== undefined) {
					return Promise.reject(opts.sendRejection);
				}
				return Promise.resolve(undefined);
			default:
				return Promise.resolve(undefined);
		}
	});
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
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

	it("gives a current-file comment its own section, not a blank commit group", async () => {
		installReads({
			commits,
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "note on A"),
				currentFileComment("cf", "this constant needs a name"),
			],
			resolutions: [resolvable("c1"), resolvable("cf")],
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
			within(
				screen.getByRole("listitem", { name: "Current file content" }),
			).getByRole("button", { name: "Open src/untouched.ts" }),
		).toBeInTheDocument();
		const groups = screen
			.getAllByRole("listitem", { name: /^Commit / })
			.map((group) => group.getAttribute("aria-label"));
		expect(groups).toEqual(["Commit aaaaaaa", "Commit bbbbbbb"]);
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

	it("counts the threads under each commit", async () => {
		installReads({
			commits,
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "first on A"),
				lineAnchoredComment("c2", COMMIT_A, "second on A"),
				commitLevelComment("c3", COMMIT_B, "note on B"),
			],
			resolutions: [resolvable("c1"), resolvable("c2"), resolvable("c3")],
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

		const groupA = screen.getByRole("listitem", { name: "Commit aaaaaaa" });
		expect(within(groupA).getByTitle("2 threads")).toHaveTextContent("2");
		const groupB = screen.getByRole("listitem", { name: "Commit bbbbbbb" });
		expect(within(groupB).getByTitle("1 thread")).toHaveTextContent("1");
	});

	// 260531-l02d: an auto-added snapshot with no comments is noise — hide it. An empty
	// hand-picked commit stays so its per-commit "Add note" affordance remains.
	it("hides empty snapshot sections but keeps empty hand-picked sections", async () => {
		installReads({
			commits: [
				aSessionCommit({
					oid: COMMIT_A,
					short_oid: "aaaaaaa",
					summary: "Uncommitted changes",
					is_snapshot: true,
				}),
				aSessionCommit({
					oid: COMMIT_B,
					short_oid: "bbbbbbb",
					summary: "hand-picked",
				}),
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
		// The empty-review state must NOT fire when comments exist.
		expect(
			screen.queryByRole("heading", {
				name: "This review is active and empty",
			}),
		).not.toBeInTheDocument();
	});

	describe("add note", () => {
		function noteSubmit(): HTMLElement {
			return within(
				screen.getByRole("group", { name: "Note on aaaaaaa" }),
			).getByRole("button", { name: "Add note" });
		}

		it("writes a commit-level comment via add_commit_thread on Add note", async () => {
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

			await fireEvent.click(noteSubmit());
			await flush();

			expect(calledCommands()).toContain("add_commit_thread");
			const args = callArgs("add_commit_thread");
			expect(args?.commitOid).toBe(COMMIT_A);
			expect(args?.text).toBe("a fresh note");
		});

		it.each([
			["holds the note in a new batch from Start a batch", 0, "Start a batch"],
			["adds the note to the batch the review holds", 1, "Add to batch"],
		] as const)("%s", async (_, pendingCount, label) => {
			installReads({
				commits,
				comments: [],
				resolutions: [],
				reviews: [aReview({ pending_count: pendingCount })],
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
			await fireEvent.click(screen.getAllByText("Add note")[0]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "a fresh note" },
			});

			await fireEvent.click(
				within(
					screen.getByRole("group", { name: "Note on aaaaaaa" }),
				).getByRole("button", { name: label }),
			);
			await flush();

			expect(callArgs("add_commit_thread")?.delivery).toBe("hold");
		});

		it("disables Add note while the add-note textarea is empty/whitespace", async () => {
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

			const saveBtn = noteSubmit();
			expect(saveBtn).toBeDisabled();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "   " } });
			await tick();
			expect(saveBtn).toBeDisabled();

			await fireEvent.input(textarea, { target: { value: "real" } });
			await tick();
			expect(saveBtn).not.toBeDisabled();
		});

		it("keeps the note target and draft through a panel remount", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			const editors = createReviewEditorStore();
			const noteRequests: Array<[string | null, string]> = [];
			const panelProps = {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				editorNoteSessionFor: (reviewId: string | null, surface: string) => {
					noteRequests.push([reviewId, surface]);
					return editors.note(reviewId, surface);
				},
			};

			const first = render(ReviewPanel, { props: panelProps });
			await flush();
			await fireEvent.click(screen.getAllByText("Add note")[0]);
			await tick();
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "unfinished note" },
			});
			await tick();

			first.unmount();
			render(ReviewPanel, { props: panelProps });
			await tick();

			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			expect(textarea.value).toBe("unfinished note");
			await fireEvent.click(noteSubmit());
			await flush();

			const args = callArgs("add_commit_thread");
			expect(args?.commitOid).toBe(COMMIT_A);
			expect(args?.text).toBe("unfinished note");
			expect(noteRequests).toContainEqual([ACTIVE_REVIEW, "review-note"]);
		});

		it("restores and saves an externally owned note after Hide all", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			const editors = createReviewEditorStore();
			const props = {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				editorNoteSessionFor: (reviewId: string | null, surface: string) =>
					editors.note(reviewId, surface),
				reviewFilter: ALL_THREADS as ReviewFilter,
			};
			const view = render(ReviewPanel, { props });
			await flush();
			await fireEvent.click(screen.getAllByText("Add note")[0]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "retained panel note" },
			});

			await view.rerender({ ...props, reviewFilter: "none" });
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			view.unmount();
			render(ReviewPanel, { props });
			await tick();

			expect(screen.getByRole("textbox")).toHaveValue("retained panel note");
			await fireEvent.click(noteSubmit());
			expect(callArgs("add_commit_thread")).toEqual({
				path: "/repo",
				commitOid: COMMIT_A,
				text: "retained panel note",
				delivery: "send",
			});
		});

		it("allows only one add-note write while one is pending", async () => {
			installReads({ commits, comments: [], resolutions: [] });
			let settleSave!: () => void;
			vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
				cmd === "add_commit_thread"
					? new Promise<void>((resolve) => {
							settleSave = resolve;
						})
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

			await fireEvent.click(screen.getAllByText("Add note")[0]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "one note" },
			});
			const saveButton = noteSubmit();
			await fireEvent.click(saveButton);
			await tick();

			expect(saveButton).toBeDisabled();
			await fireEvent.click(saveButton);
			expect(
				calledCommands().filter((command) => command === "add_commit_thread"),
			).toHaveLength(1);

			settleSave();
			await flush();
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

			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
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

		it("restores and saves a root edit after its filter hides the thread", async () => {
			const comment = lineAnchoredComment("c1", COMMIT_A, "original");
			installReads({
				commits,
				comments: [comment],
				resolutions: [resolvable("c1")],
			});
			const editors = createReviewEditorStore();
			const props = {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				editorSessionForThread: (thread: Thread) =>
					editors.thread(ACTIVE_REVIEW, "review-panel", thread.id),
				reviewFilter: ALL_THREADS as ReviewFilter,
			};
			const view = render(ReviewPanel, { props });
			await flush();
			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
			await fireEvent.input(screen.getAllByRole("textbox")[0], {
				target: { value: "retained root edit" },
			});

			await view.rerender({ ...props, reviewFilter: SETTLED });
			expect(
				screen.queryByDisplayValue("retained root edit"),
			).not.toBeVisible();
			view.unmount();
			render(ReviewPanel, { props });
			await tick();

			const restored = screen.getByDisplayValue("retained root edit");
			expect(restored).toBeVisible();
			await fireEvent.click(screen.getByText("Save"));
			expect(callArgs("edit_thread")).toEqual({
				path: "/repo",
				id: "c1",
				text: "retained root edit",
			});
		});

		it("restores and saves a reply edit after Hide all", async () => {
			const comment = aThread({
				...lineAnchoredComment("c1", COMMIT_A, "original"),
				replies: [
					{
						id: "reply-1",
						text: "reply original",
						text_html: "",
						channel: "human",
						created_at: 1_000,
						pending: false,
					},
				],
			});
			installReads({
				commits,
				comments: [comment],
				resolutions: [resolvable("c1")],
			});
			const editors = createReviewEditorStore();
			const props = {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				editorSessionForThread: (thread: Thread) =>
					editors.thread(ACTIVE_REVIEW, "review-panel", thread.id),
				reviewFilter: ALL_THREADS as ReviewFilter,
			};
			const view = render(ReviewPanel, { props });
			await flush();
			await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
			await fireEvent.input(
				screen.getByRole("textbox", { name: "Edit reply" }),
				{ target: { value: "retained reply edit" } },
			);

			await view.rerender({ ...props, reviewFilter: "none" });
			expect(
				screen.queryByRole("textbox", { name: "Edit reply" }),
			).not.toBeInTheDocument();
			view.unmount();
			render(ReviewPanel, { props });
			await tick();

			const restored = screen.getByRole("textbox", { name: "Edit reply" });
			expect(restored).toHaveValue("retained reply edit");
			await fireEvent.click(screen.getByText("Save"));
			expect(callArgs("edit_reply")).toEqual({
				path: "/repo",
				id: "reply-1",
				text: "retained reply edit",
			});
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

			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
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

			await fireEvent.click(
				screen.getByRole("button", { name: "Edit comment" }),
			);
			await tick();
			await fireEvent.click(screen.getByText("Cancel"));
			await flush();

			expect(calledCommands()).not.toContain("edit_thread");
			expect(screen.getByText("original")).toBeInTheDocument();
		});
	});

	describe("state change", () => {
		it("invokes set_thread_state with the id and target state on Mark done", async () => {
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

			await fireEvent.click(screen.getByText("Mark done"));
			await flush();

			expect(calledCommands()).toContain("set_thread_state");
			expect(callArgs("set_thread_state")).toEqual({
				path: "/repo",
				id: "c1",
				next: "done",
			});
		});
	});

	describe("thread reply actions", () => {
		it("submits a reply via addReply with the repo path", async () => {
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

			const textarea = screen.getByLabelText("Reply") as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "reply text" } });
			await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
			await flush();

			expect(calledCommands()).toContain("add_reply");
			expect(callArgs("add_reply")).toEqual({
				path: "/repo",
				threadId: "c1",
				text: "reply text",
				delivery: "send",
			});
		});

		it("edits a reply via editReply with the repo path", async () => {
			const withReply = lineAnchoredComment("c1", COMMIT_A, "original");
			withReply.replies = [
				{
					id: "r1",
					text: "original reply",
					text_html: "",
					channel: "human",
					created_at: 1_000,
					pending: false,
				},
			];
			installReads({
				commits,
				comments: [withReply],
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

			await fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
			const textarea = screen.getByRole("textbox", {
				name: "Edit reply",
			}) as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "corrected" } });
			await fireEvent.click(screen.getByText("Save"));
			await flush();

			expect(calledCommands()).toContain("edit_reply");
			expect(callArgs("edit_reply")).toEqual({
				path: "/repo",
				id: "r1",
				text: "corrected",
			});
		});

		it("deletes a reply via deleteReply with the repo path once confirmed", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
			const withReply = lineAnchoredComment("c1", COMMIT_A, "original");
			withReply.replies = [
				{
					id: "r1",
					text: "doomed reply",
					text_html: "",
					channel: "agent",
					created_at: 1_000,
					pending: false,
				},
			];
			installReads({
				commits,
				comments: [withReply],
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
				screen.getByRole("button", { name: "Delete reply" }),
			);
			await waitFor(() => expect(calledCommands()).toContain("delete_reply"));

			expect(calledCommands()).toContain("delete_reply");
			expect(callArgs("delete_reply")).toEqual({ path: "/repo", id: "r1" });
		});
	});

	describe("delete", () => {
		it("does not invoke delete_thread when the confirm is cancelled", async () => {
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

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
			await flush();

			expect(calledCommands()).not.toContain("delete_thread");
		});

		it("invokes delete_thread by id when the confirm is accepted", async () => {
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

			await fireEvent.click(
				screen.getByRole("button", { name: "Delete comment" }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
			await waitFor(() => expect(calledCommands()).toContain("delete_thread"));

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

			await fireEvent.click(
				screen.getByRole("button", { name: "Lines 10–12" }),
			);
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

			// The Orphaned flag names the LOCKED reason.
			expect(
				screen.getByTitle("File gone. Only the saved excerpt survives."),
			).toHaveTextContent("Orphaned");
			expect(
				screen.getByRole("button", { name: "Lines 10–12" }),
			).toBeDisabled();
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

			expect(
				screen.getByTitle("File gone. Only the saved excerpt survives."),
			).toHaveTextContent("Orphaned");
			expect(
				screen.getByRole("button", { name: "Lines 10–12" }),
			).toBeDisabled();
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
				screen.getByRole("button", { name: commits[0].short_oid }),
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

			expect(
				screen.getByTitle("Commit gone. Only the saved excerpt survives."),
			).toHaveTextContent("Orphaned");
			expect(
				screen.getByTitle(
					"Line out of range. Only the saved excerpt survives.",
				),
			).toHaveTextContent("Orphaned");
			expect(
				screen.getByTitle("File gone. Only the saved excerpt survives."),
			).toHaveTextContent("Orphaned");
		});
	});

	// Copy writes the doc of the threads the panel shows, so the filter decides
	// what reaches the clipboard (João, 2026-10-08).
	describe("Copy", () => {
		const OPEN = lineAnchoredComment("c1", COMMIT_A, "look here");
		const DONE = aThread({ id: "c2", commit_oid: COMMIT_A, state: "done" });

		function renderCopy(
			opts: {
				comments?: Thread[];
				reviewFilter?: ReviewFilter;
				generateRejection?: unknown;
			} = {},
		) {
			const comments = opts.comments ?? [OPEN];
			installReads({
				commits,
				comments,
				reviews: [aReview({ thread_count: comments.length })],
				generateDoc: "the doc",
				generateRejection: opts.generateRejection,
			});
			return render(ReviewPanel, {
				props: {
					repoPath: "/repo",
					session: createReviewSession(),
					reviewComments,
					reviewFilter: opts.reviewFilter ?? ALL_THREADS,
					onJump: vi.fn(),
					onJumpToCommit: vi.fn(),
				},
			});
		}

		function getCopyButton() {
			return screen.getByRole("button", { name: "Copy" });
		}

		it("copies the doc of every thread the panel shows", async () => {
			renderCopy({ comments: [OPEN, DONE] });
			await flush();

			await fireEvent.click(getCopyButton());
			await flush();

			expect(callArgs("generate_review_doc")).toEqual({
				path: "/repo",
				reviewId: ACTIVE_REVIEW,
				threadIds: ["c1", "c2"],
			});
			expect(vi.mocked(writeText)).toHaveBeenCalledWith("the doc");
		});

		it("says how many threads it copied", async () => {
			renderCopy({ comments: [OPEN, DONE] });
			await flush();

			await fireEvent.click(getCopyButton());
			await flush();

			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				`Copied 2 threads from ${ACTIVE_REVIEW} as an agent prompt`,
				"success",
			);
		});

		describe("when the filter hides some threads", () => {
			it("leaves the hidden threads out", async () => {
				renderCopy({ comments: [OPEN, DONE], reviewFilter: NEEDS_ME });
				await flush();

				await fireEvent.click(getCopyButton());
				await flush();

				expect(callArgs("generate_review_doc")).toMatchObject({
					threadIds: ["c1"],
				});
			});

			it("copies a view of settled threads alone", async () => {
				renderCopy({ comments: [OPEN, DONE], reviewFilter: SETTLED });
				await flush();

				await fireEvent.click(getCopyButton());
				await flush();

				expect(callArgs("generate_review_doc")).toMatchObject({
					threadIds: ["c2"],
				});
			});

			it("is disabled while the view shows no thread", async () => {
				renderCopy({ comments: [OPEN], reviewFilter: SETTLED });
				await flush();

				expect(getCopyButton()).toBeDisabled();
				expect(getCopyButton()).toHaveAttribute(
					"title",
					"No threads shown to copy",
				);
			});
		});

		it.each([
			[new Error("plugin disabled"), "Failed to copy: plugin disabled"],
			["raw string", "Failed to copy: raw string"],
		])("toasts a clipboard failure %#", async (rejection, message) => {
			vi.mocked(writeText).mockRejectedValueOnce(rejection);
			renderCopy();
			await flush();

			await fireEvent.click(getCopyButton());
			await flush();

			expect(vi.mocked(showToast)).toHaveBeenCalledWith(message, "error");
			expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(
				expect.stringMatching(/^Copied/),
				"success",
			);
		});

		it("surfaces the message when generate rejects with a TrunkError", async () => {
			renderCopy({
				generateRejection: {
					code: "no_comments",
					message: "No comments to include",
				},
			});
			await flush();

			await fireEvent.click(getCopyButton());
			await flush();

			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				"Failed to copy: No comments to include",
				"error",
			);
		});
	});
});

// Ending a review sends its held comments, after a popover under the button
// says what that means.
describe("Send", () => {
	function renderWithSession(opts: { sendRejection?: unknown } = {}) {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			resolutions: [resolvable("c1")],
			sendRejection: opts.sendRejection,
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

	async function openPopover() {
		await fireEvent.click(screen.getByRole("button", { name: "Send 1" }));
		await flush();
		return screen.getByRole("dialog", { name: `Send ${ACTIVE_REVIEW}?` });
	}

	it("counts the held comments it sends", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			reviews: [aReview({ thread_count: 1, pending_count: 3 })],
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

		expect(screen.getByRole("button", { name: "Send 3" })).toBeInTheDocument();
	});

	it("asks before sending, and says what sending does", async () => {
		renderWithSession();
		await flush();

		const popover = await openPopover();

		expect(popover).toHaveTextContent(
			"The agent will be able to read and reply to 1 held comment. Nothing is deleted.",
		);
		expect(calledCommands()).not.toContain("send_review");
	});

	it("sends the shown review's batch from the popover", async () => {
		renderWithSession();
		await flush();
		const popover = await openPopover();

		await fireEvent.click(
			within(popover).getByRole("button", { name: "Send" }),
		);
		await flush();

		expect(callArgs("send_review")).toEqual({
			path: "/repo",
			reviewId: ACTIVE_REVIEW,
		});
		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			`${ACTIVE_REVIEW} sent`,
			"success",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it.each([
		[
			"Cancel",
			(popover: HTMLElement) =>
				within(popover).getByRole("button", { name: "Cancel" }).click(),
		],
		[
			"Escape",
			(popover: HTMLElement) => fireEvent.keyDown(popover, { key: "Escape" }),
		],
	])("closes without sending on %s", async (_, dismiss) => {
		renderWithSession();
		await flush();
		const popover = await openPopover();

		await dismiss(popover);
		await flush();

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(calledCommands()).not.toContain("send_review");
	});

	it("is hidden while the review holds nothing", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "x")],
			reviews: [aReview({ thread_count: 1, pending_count: 0 })],
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

		expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
	});

	it("surfaces a send-failure toast when send_review rejects", async () => {
		renderWithSession({
			sendRejection: {
				code: "no_session",
				message: "No active review session",
			},
		});
		await flush();
		const popover = await openPopover();

		await fireEvent.click(
			within(popover).getByRole("button", { name: "Send" }),
		);
		await flush();

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"Failed to send review: No active review session",
			"error",
		);
		expect(screen.getByText("x")).toBeInTheDocument();
	});
});

// The reviews list beside the panel picks which review it shows.
describe("the shown review", () => {
	const READY: Review = {
		id: "READYRV1",
		title: "Auth review",
		state: "open",
		visible_to_agent: true,
		archived: false,
		thread_count: 2,
		unresolved_count: 1,
		pending_count: 0,
		created_at: 0,
	};

	function renderPanel() {
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

	it("shows the threads of the review it shows, not the active one's", async () => {
		installReads({
			reviews: [aReview(), READY],
			activeReviewId: ACTIVE_REVIEW,
			comments: [commitLevelComment("mine", COMMIT_A, "on the active review")],
			otherReviews: {
				[READY.id]: {
					threads: [
						commitLevelComment("theirs", COMMIT_A, "on the other review"),
					],
					commits: [aSessionCommit({ oid: COMMIT_A })],
				},
			},
		});
		renderPanel();
		await flush();

		await reviewComments.select(READY.id);
		await flush();

		expect(screen.getByText("on the other review")).toBeInTheDocument();
		expect(screen.queryByText("on the active review")).toBeNull();
	});
});

describe("empty states", () => {
	function renderPanel(
		onreviewfilterchange?: (filter: ReviewFilter) => void,
		reviewFilter: ReviewFilter = ALL_THREADS,
	) {
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				reviewFilter,
				onreviewfilterchange,
			},
		});
	}

	it("explains reviews and how to comment when the repository has none", async () => {
		installReads({ reviews: [], activeReviewId: null });
		renderPanel();
		await flush();

		expect(
			screen.getByRole("heading", { name: "No reviews in this repository" }),
		).toBeInTheDocument();
		expect(
			within(screen.getByRole("list", { name: "Ways to comment" }))
				.getAllByRole("listitem")
				.map((step) => step.textContent?.trim()),
		).toEqual([
			"Comment on selected diff lines",
			"Note on a whole commit",
			"Comment on any tracked file",
		]);
	});

	it("says an agent reads a comment as soon as it is added", async () => {
		installReads({ reviews: [], activeReviewId: null });
		renderPanel();
		await flush();

		expect(
			screen.getByText(/An agent reads each comment .* as soon as you add it/),
		).toBeInTheDocument();
		expect(screen.queryByText(/end it/)).toBeNull();
	});

	it("starts a review from the empty repository", async () => {
		installReads({ reviews: [], activeReviewId: null });
		renderPanel();
		await flush();

		const empty = screen.getByRole("region", {
			name: "No reviews in this repository",
		});
		await fireEvent.click(
			within(empty).getByRole("button", { name: "New review" }),
		);

		expect(callArgs("create_review")).toEqual({ path: "/repo", title: null });
	});

	it("draws no thread tally for a review without threads", async () => {
		installReads({ commits, comments: [] });
		renderPanel();
		await flush();

		expect(
			screen.queryByRole("list", { name: "Show threads by state" }),
		).toBeNull();
	});

	it("says the active review is empty and that new comments land in it", async () => {
		installReads({ commits, comments: [] });
		renderPanel();
		await flush();

		expect(
			screen.getByRole("heading", { name: "This review is active and empty" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/New comments you write anywhere in this repo land here/,
			),
		).toBeInTheDocument();
	});

	it("says the agent reads an empty review's comments once they are sent", async () => {
		installReads({ commits, comments: [] });
		renderPanel();
		await flush();

		expect(
			screen.getByText(
				/The agent reads each comment as soon as you add it, or when you send the batch you hold it in/,
			),
		).toBeInTheDocument();
	});

	it("says a review that is not active collects no comments until it is", async () => {
		const other = aReview({ id: "OTHER001", title: "Other review" });
		installReads({ reviews: [aReview(), other], comments: [] });
		renderPanel();
		await flush();

		await reviewComments.select(other.id);
		await flush();

		expect(
			screen.getByRole("heading", { name: "No comments in this review" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Make it active to collect new comments here/),
		).toBeInTheDocument();
	});

	it("says the next comment starts a review when none is active or shown", async () => {
		installReads({
			reviews: [aReview({ archived: true })],
			activeReviewId: null,
			comments: [],
		});
		renderPanel();
		await flush();

		expect(
			screen.getByRole("heading", { name: "No review is active" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Your next comment starts a new review/),
		).toBeInTheDocument();
	});

	it("says an empty archived review collects no comments until it is unarchived", async () => {
		const archived = aReview({
			id: "OTHER001",
			title: "Other review",
			archived: true,
		});
		installReads({ reviews: [aReview(), archived], comments: [] });
		renderPanel();
		await flush();

		await reviewComments.select(archived.id);
		await flush();

		expect(
			screen.getByText(/Unarchive it to collect new comments here/),
		).toBeInTheDocument();
	});

	it("offers every thread back when the filter hides them all", async () => {
		installReads({
			commits,
			comments: [lineAnchoredComment("c1", COMMIT_A, "still open")],
		});
		const onreviewfilterchange = vi.fn();
		renderPanel(onreviewfilterchange, SETTLED);
		await flush();

		await fireEvent.click(screen.getByRole("button", { name: "Show all" }));

		expect(screen.getByText(/No threads here/)).toBeVisible();
		expect(onreviewfilterchange).toHaveBeenCalledWith(ALL_THREADS);
	});
});

// The header names the active review and counts its threads by state; hidden
// when the repo has no review.
describe("header", () => {
	function renderPanel(
		props: {
			reviewFilter?: ReviewFilter;
			onreviewfilterchange?: (filter: ThreadFilter) => void;
		} = {},
	) {
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				...props,
			},
		});
	}

	const THREADS = [
		aThread({ id: "t1", commit_oid: COMMIT_A, state: "open" }),
		aThread({ id: "t2", commit_oid: COMMIT_A, state: "open", stale: true }),
		aThread({ id: "t3", commit_oid: COMMIT_A, state: "addressed" }),
		aThread({ id: "t4", commit_oid: COMMIT_A, state: "done" }),
	];

	const OTHER: Review = {
		id: "OTHERRV1",
		title: "Other review",
		state: "open",
		visible_to_agent: true,
		archived: false,
		thread_count: 0,
		unresolved_count: 0,
		pending_count: 0,
		created_at: 0,
	};

	function header() {
		return screen
			.getByRole("heading", { level: 1 })
			.closest("header") as HTMLElement;
	}

	it("names the shown review by title, id and state", async () => {
		installReads({
			commits,
			comments: THREADS,
			reviews: [aReview({ title: "Watcher review", state: "open" })],
		});
		renderPanel();
		await flush();

		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
			"Watcher review",
		);
		expect(header()).toHaveTextContent(ACTIVE_REVIEW);
		expect(header()).toHaveTextContent("Open");
	});

	it("names a review by an older default title without its id twice", async () => {
		installReads({
			commits,
			comments: THREADS,
			reviews: [aReview({ title: `Review 2026-08-12 · ${ACTIVE_REVIEW}` })],
		});
		renderPanel();
		await flush();

		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
			/^Review 2026-08-12$/,
		);
		expect(screen.getByText("2026-08-12")).toHaveClass("whitespace-nowrap");
	});

	describe("renaming from the title", () => {
		async function openTitleEditor() {
			installReads({ commits, comments: THREADS });
			renderPanel();
			await flush();
			await fireEvent.click(
				screen.getByRole("button", { name: aReview().title }),
			);
			await tick();
			return screen.getByRole("textbox", { name: "Review title" });
		}

		it("opens a field holding the title", async () => {
			const field = await openTitleEditor();

			expect(field).toHaveValue(aReview().title);
		});

		it("puts the focus in the field with the title selected, ready to type over", async () => {
			const field = (await openTitleEditor()) as HTMLInputElement;

			expect(field).toHaveFocus();
			expect([field.selectionStart, field.selectionEnd]).toEqual([
				0,
				field.value.length,
			]);
		});

		it("opens a plain field, since the caret shows where typing goes", async () => {
			const field = await openTitleEditor();

			expect(field).toHaveClass("border-border", "outline-none");
			expect(field).not.toHaveClass("border-accent");
		});

		it("saves the new title on Enter", async () => {
			const field = await openTitleEditor();

			await fireEvent.input(field, { target: { value: "Renamed" } });
			await fireEvent.keyDown(field, { key: "Enter" });
			await flush();

			expect(callArgs("rename_review")).toEqual({
				path: "/repo",
				reviewId: ACTIVE_REVIEW,
				title: "Renamed",
			});
		});

		it("keeps the title on Escape", async () => {
			const field = await openTitleEditor();

			await fireEvent.input(field, { target: { value: "Renamed" } });
			await fireEvent.keyDown(field, { key: "Escape" });
			await flush();

			expect(calledCommands()).not.toContain("rename_review");
			expect(
				screen.queryByRole("textbox", { name: "Review title" }),
			).toBeNull();
		});
	});

	describe("tally toggles", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		function toggle(name: string): HTMLElement {
			return within(
				screen.getByRole("list", { name: "Show threads by state" }),
			).getByRole("button", { name: `${name} threads` });
		}

		it("counts the shown review's threads in each state it holds", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel();
			await flush();

			expect(toggle("Open")).toHaveTextContent("2");
			expect(toggle("Addressed")).toHaveTextContent("1");
			expect(toggle("Done")).toHaveTextContent("1");
			expect(toggle("Stale")).toHaveTextContent("1");
			expect(
				screen.queryByRole("button", { name: "Dismissed threads" }),
			).toBeNull();
		});

		it("presses every toggle while every thread shows", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel();
			await flush();

			for (const name of ["Open", "Addressed", "Done", "Stale"]) {
				expect(toggle(name)).toHaveAttribute("aria-pressed", "true");
			}
		});

		it("releases the toggle of a state the filter hides", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			expect(toggle("Done")).toHaveAttribute("aria-pressed", "false");
			expect(toggle("Open")).toHaveAttribute("aria-pressed", "true");
		});

		it("releases every toggle while review threads are hidden", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: "none" });
			await flush();

			for (const name of ["Open", "Addressed", "Done", "Stale"]) {
				expect(toggle(name)).toHaveAttribute("aria-pressed", "false");
			}
		});

		it("hides a state's threads when its toggle is pressed", async () => {
			const onreviewfilterchange = vi.fn();
			installReads({ commits, comments: THREADS });
			renderPanel({ onreviewfilterchange });
			await flush();

			await fireEvent.click(toggle("Done"));

			expect(onreviewfilterchange).toHaveBeenCalledWith({
				states: ["open", "addressed", "dismissed"],
				stale: true,
			});
		});

		it("hides the stale threads when the stale toggle is pressed", async () => {
			const onreviewfilterchange = vi.fn();
			installReads({ commits, comments: THREADS });
			renderPanel({ onreviewfilterchange });
			await flush();

			await fireEvent.click(toggle("Stale"));

			expect(onreviewfilterchange).toHaveBeenCalledWith({
				...ALL_THREADS,
				stale: false,
			});
		});

		it("says what a toggle counts and what pressing it does", async () => {
			vi.useFakeTimers();
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			await fireEvent.mouseEnter(toggle("Done"));
			vi.advanceTimersByTime(SHOW_DELAY_MS);

			expect(document.querySelector(".tooltip-pop")).toHaveTextContent(
				"Done: 1 thread. Click to show.",
			);
		});
	});

	it("says the review is active and not yet visible to the agent", async () => {
		installReads({ commits, comments: THREADS });
		renderPanel();
		await flush();

		expect(header()).toHaveTextContent("Active");
		expect(header()).toHaveTextContent("Not visible to the agent");
		expect(screen.queryByRole("button", { name: "Make active" })).toBeNull();
	});

	describe("for a review that is not the active one", () => {
		async function showOther() {
			installReads({
				commits,
				comments: THREADS,
				reviews: [aReview({ thread_count: 4 }), OTHER],
			});
			renderPanel();
			await flush();
			await reviewComments.select(OTHER.id);
			await flush();
		}

		it("archives it from its header", async () => {
			await showOther();

			await fireEvent.click(screen.getByRole("button", { name: "Archive" }));
			await flush();

			expect(callArgs("archive_review")).toEqual({
				path: "/repo",
				reviewId: OTHER.id,
			});
		});

		async function showArchived(overrides: Partial<Review> = {}) {
			installReads({
				commits,
				comments: THREADS,
				reviews: [
					aReview({ thread_count: 4 }),
					{ ...OTHER, archived: true, visible_to_agent: false, ...overrides },
				],
			});
			renderPanel();
			await flush();
			await reviewComments.select(OTHER.id);
			await flush();
		}

		it("says it is archived and offers no way to make it active", async () => {
			await showArchived();

			expect(header()).toHaveTextContent("Archived");
			expect(screen.queryByRole("button", { name: "Make active" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
		});

		it("unarchives it from its header", async () => {
			await showArchived();

			await fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
			await flush();

			expect(callArgs("unarchive_review")).toEqual({
				path: "/repo",
				reviewId: OTHER.id,
			});
		});

		it("says the agent cannot see it once archived, whatever it was sent", async () => {
			await showArchived();

			expect(header()).toHaveTextContent("Not visible to the agent");
		});

		it("says held comments sent from an archived review wait on unarchiving", async () => {
			await showArchived({ pending_count: 1 });

			await fireEvent.click(screen.getByRole("button", { name: "Send 1" }));
			await flush();

			expect(
				screen.getByRole("dialog", { name: `Send ${OTHER.id}?` }),
			).toHaveTextContent(
				"The agent will be able to read and reply to 1 held comment once the review is unarchived. Nothing is deleted.",
			);
		});

		it("offers to make it active", async () => {
			await showOther();

			await fireEvent.click(
				screen.getByRole("button", { name: "Make active" }),
			);
			await flush();

			expect(callArgs("set_active_review")).toEqual({
				path: "/repo",
				reviewId: OTHER.id,
			});
		});

		it("says the agent sees it", async () => {
			await showOther();

			expect(header()).toHaveTextContent("Visible to the agent");
		});

		it("offers nothing to send when it holds no batch", async () => {
			await showOther();

			expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
		});

		it("reads its own resolutions", async () => {
			await showOther();

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("resolve_threads", {
				path: "/repo",
				reviewId: OTHER.id,
			});
		});
	});

	describe("presets", () => {
		function preset(label: string): HTMLElement {
			return within(header()).getByRole("button", {
				name: new RegExp(`^${label}`),
			});
		}

		it("counts the threads each preset shows", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel();
			await flush();

			expect(preset("All")).toHaveTextContent("4");
			expect(preset("Needs me")).toHaveTextContent("3");
			expect(preset("Settled")).toHaveTextContent("1");
		});

		it("presses the preset whose threads show", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			expect(preset("Needs me")).toHaveAttribute("aria-pressed", "true");
			expect(preset("All")).toHaveAttribute("aria-pressed", "false");
		});

		it("presses no preset for a mix of states none holds", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: { states: ["open", "done"], stale: true } });
			await flush();

			for (const label of ["All", "Needs me", "Settled"]) {
				expect(preset(label)).toHaveAttribute("aria-pressed", "false");
			}
		});

		it("asks for a preset's threads when it is pressed", async () => {
			const onreviewfilterchange = vi.fn();
			installReads({ commits, comments: THREADS });
			renderPanel({ onreviewfilterchange });
			await flush();

			await fireEvent.click(preset("Settled"));

			expect(onreviewfilterchange).toHaveBeenCalledWith(SETTLED);
		});
	});

	describe("under a filter", () => {
		it("says how many threads it hides", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			expect(screen.getByText(/1 thread\s+hidden\./)).toBeVisible();
		});

		it("shows every thread again from Show all", async () => {
			const onreviewfilterchange = vi.fn();
			installReads({ commits, comments: THREADS });
			renderPanel({ reviewFilter: NEEDS_ME, onreviewfilterchange });
			await flush();

			await fireEvent.click(screen.getByRole("button", { name: "Show all" }));

			expect(onreviewfilterchange).toHaveBeenCalledWith(ALL_THREADS);
		});

		it("says nothing is hidden while every thread shows", async () => {
			installReads({ commits, comments: THREADS });
			renderPanel();
			await flush();

			expect(screen.queryByText(/hidden\./)).toBeNull();
		});

		it("drops a commit whose threads it hides", async () => {
			installReads({
				commits,
				comments: [
					aThread({ id: "t1", commit_oid: COMMIT_A, state: "open" }),
					aThread({ id: "t4", commit_oid: COMMIT_B, state: "done" }),
				],
			});
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			expect(screen.getByText("bbbbbbb")).not.toBeVisible();
		});

		it("counts only the commits and threads it shows on the branch", async () => {
			installReads({
				commits,
				comments: [
					aThread({ id: "t1", commit_oid: COMMIT_A, state: "open" }),
					aThread({ id: "t4", commit_oid: COMMIT_B, state: "done" }),
				],
			});
			renderPanel({ reviewFilter: NEEDS_ME });
			await flush();

			expect(screen.getByText("1 commit · 1 thread")).toBeVisible();
		});
	});

	it("names no review when the repo has none", async () => {
		installReads({ reviews: [], activeReviewId: null });
		renderPanel();
		await flush();

		expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
		expect(
			screen.queryByRole("list", { name: "Show threads by state" }),
		).toBeNull();
	});
});

describe("Hide all filter", () => {
	it("hides review cards and creation affordances but leaves management available", async () => {
		installReads({
			commits: commits.slice(0, 1),
			comments: [lineAnchoredComment("c1", COMMIT_A, "hidden note")],
			resolutions: [resolvable("c1")],
		});
		const oncommentonfile = vi.fn();
		const { container } = render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				reviewFilter: "none",
				oncommentonfile,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
			},
		});
		await flush();

		expect(
			screen.queryByRole("button", { name: "Comment on a file…" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Add note" }),
		).not.toBeInTheDocument();
		expect(container.querySelector(".comment-card")?.parentElement).toHaveStyle(
			{
				display: "none",
			},
		);
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
		expect(oncommentonfile).not.toHaveBeenCalled();
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

	// A store the build refuses fails every read, and the store poll re-fires
	// on every change, so an unchanged failure arrived once per refresh and
	// stacked one identical toast per arrival — a wall of them over the panel.
	// The failure is one condition, so it is told once.
	it("toasts an unchanged failure once across many refreshes", async () => {
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

		for (let i = 0; i < 5; i++) {
			await reviewComments.refresh();
			await flush();
		}

		const errorToasts = vi
			.mocked(showToast)
			.mock.calls.filter((c) => c[1] === "error");
		expect(errorToasts).toHaveLength(1);
	});

	// Silencing the repeat must not silence the recurrence: a failure that
	// clears and returns is news again.
	it("toasts again when a failure clears and then returns", async () => {
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

		reviewComments.seed({ lastError: null });
		await reviewComments.refresh();
		await flush();

		reviewComments.seed({ lastError: "Repository is not open" });
		await reviewComments.refresh();
		await flush();

		const errorToasts = vi
			.mocked(showToast)
			.mock.calls.filter((c) => c[1] === "error");
		expect(errorToasts).toHaveLength(2);
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
				aSessionCommit({
					oid: COMMIT_B,
					short_oid: "ccccccc",
					summary: "amended commit",
				}),
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

		// Initial warm render: comment visible, Send button visible.
		expect(screen.getByText("tab-A note")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Send/ })).toBeInTheDocument();

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

		// Cold empty state now visible; warm copy and prior comment gone; Send
		// button hidden (no active review → the {#if} gate hides it).
		expect(
			screen.getByRole("heading", { name: "No reviews in this repository" }),
		).toBeInTheDocument();
		expect(screen.queryByText("tab-A note")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
	});
});

describe("comment on a file", () => {
	beforeEach(() => {
		installReads({});
	});

	function renderPanel(oncommentonfile = vi.fn()) {
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				oncommentonfile,
			},
		});
		return oncommentonfile;
	}

	it("offers the entry point in the panel header", async () => {
		renderPanel();
		await flush();

		expect(
			screen.getByRole("button", { name: /Comment on a file/ }),
		).toBeInTheDocument();
	});

	it("asks the host to open the finder", async () => {
		const oncommentonfile = renderPanel();
		await flush();

		await fireEvent.click(
			screen.getByRole("button", { name: /Comment on a file/ }),
		);

		expect(oncommentonfile).toHaveBeenCalled();
	});

	it("offers the entry point with no comment yet, unlike Copy", async () => {
		renderPanel();
		await flush();

		expect(
			screen.getByRole("button", { name: /Comment on a file/ }),
		).not.toBeDisabled();
	});
});

describe("ReviewPanel branch sections", () => {
	const main: RefLabel = {
		name: "refs/heads/main",
		short_name: "main",
		ref_type: "LocalBranch",
		is_head: true,
		color_index: 0,
	};
	const feature: RefLabel = {
		name: "refs/heads/feature",
		short_name: "feature",
		ref_type: "LocalBranch",
		is_head: false,
		color_index: 3,
	};
	const TWO_DAYS_AGO = Math.floor(Date.now() / 1000) - 2 * 86_400;

	function renderPanel(
		props: {
			onJump?: (thread: Thread) => void;
			onopenfile?: (filePath: string) => void;
		} = {},
	) {
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: props.onJump ?? vi.fn(),
				onJumpToCommit: vi.fn(),
				onopenfile: props.onopenfile,
				headBranch: "main",
			},
		});
	}

	it("gathers the review's commits under the branch each sits on", async () => {
		installReads({
			commits: [
				aSessionCommit({ oid: COMMIT_A, lane_ref: feature }),
				aSessionCommit({ oid: COMMIT_B, lane_ref: main }),
			],
		});
		renderPanel();
		await flush();

		const sections = screen.getAllByRole("region", { name: /^Branch / });

		expect(
			sections.map((s) => [
				s.getAttribute("aria-label"),
				within(s)
					.getAllByRole("listitem", { name: /^Commit / })
					.map((li) => li.getAttribute("aria-label")),
			]),
		).toEqual([
			["Branch feature", ["Commit aaaaaaa"]],
			["Branch main", ["Commit bbbbbbb"]],
		]);
	});

	it("says which branch is checked out and what its section holds", async () => {
		installReads({
			commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
			comments: [
				lineAnchoredComment("c1", COMMIT_A, "one"),
				commitLevelComment("c2", COMMIT_A, "two"),
			],
		});
		renderPanel();
		await flush();

		const section = screen.getByRole("region", { name: "Branch main" });

		expect(within(section).getByText("checked out")).toBeInTheDocument();
		expect(
			within(section).getByText("1 commit · 2 threads"),
		).toBeInTheDocument();
	});

	it("puts a commit the graph does not draw under Not on any branch", async () => {
		installReads({ commits: [aSessionCommit({ oid: COMMIT_A })] });
		renderPanel();
		await flush();

		const section = screen.getByRole("region", { name: "Not on any branch" });

		expect(
			within(section).getByRole("listitem", { name: "Commit aaaaaaa" }),
		).toBeInTheDocument();
	});

	it("shows how long ago a commit was written", async () => {
		installReads({
			commits: [
				aSessionCommit({
					oid: COMMIT_A,
					lane_ref: main,
					author_timestamp: TWO_DAYS_AGO,
				}),
			],
		});
		renderPanel();
		await flush();

		const commit = screen.getByRole("listitem", { name: "Commit aaaaaaa" });

		expect(within(commit).getByText("2d ago")).toBeInTheDocument();
	});

	it("heads each file's threads with its path, which opens the first of them", async () => {
		const onJump = vi.fn();
		const later = lineAnchoredComment("late", COMMIT_A, "later");
		const earlier = aThread({
			id: "early",
			text: "earlier",
			anchor: {
				commit_oid: COMMIT_A,
				file_path: "src/main.ts",
				source: "Diff",
				side: "New",
				start_line: 2,
				end_line: 2,
			},
		});
		installReads({
			commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
			comments: [later, earlier],
			resolutions: [resolvable("late"), resolvable("early")],
		});
		renderPanel({ onJump });
		await flush();

		await fireEvent.click(
			screen.getByRole("button", { name: "Open src/main.ts" }),
		);

		expect(onJump).toHaveBeenCalledWith(earlier);
	});

	it("names the lines each card covers in a tag", async () => {
		installReads({
			commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
			comments: [lineAnchoredComment("c1", COMMIT_A, "one")],
			resolutions: [resolvable("c1")],
		});
		renderPanel();
		await flush();

		expect(
			screen.getByRole("button", { name: "Lines 10–12" }),
		).toBeInTheDocument();
	});

	it("says a commit the repository lost no longer exists and keeps its files shut", async () => {
		installReads({
			commits: [
				aSessionCommit({ oid: COMMIT_A, summary: "gone work", exists: false }),
			],
			comments: [lineAnchoredComment("c1", COMMIT_A, "one")],
			resolutions: [orphan("c1", "CommitGone")],
		});
		renderPanel();
		await flush();

		const commit = screen.getByRole("listitem", { name: "Commit aaaaaaa" });

		expect(
			within(commit).getByText("gone work · commit no longer exists"),
		).toBeInTheDocument();
		expect(
			within(commit).getByRole("button", { name: "Open src/main.ts" }),
		).toBeDisabled();
	});

	it("gathers current-file threads under the checked-out branch", async () => {
		installReads({
			comments: [currentFileComment("cf", "name this constant")],
			resolutions: [resolvable("cf")],
		});
		renderPanel();
		await flush();

		const section = screen.getByRole("region", { name: "Branch main" });

		expect(
			within(section).getByText("Current file content · HEAD"),
		).toBeInTheDocument();
	});

	it("opens a current file's content from its path", async () => {
		const opened: string[] = [];
		installReads({
			comments: [currentFileComment("cf", "name this constant")],
			resolutions: [resolvable("cf")],
		});
		renderPanel({ onopenfile: (path) => opened.push(path) });
		await flush();

		await fireEvent.click(
			screen.getByRole("button", { name: "Open src/untouched.ts" }),
		);

		expect(opened).toEqual(["src/untouched.ts"]);
	});

	describe("while its threads scroll", () => {
		function fileBarOf(path: string): HTMLElement | null {
			return screen
				.getByRole("button", { name: `Open ${path}` })
				.closest(".review-file-head");
		}

		it("keeps a file's path pinned under its commit", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [lineAnchoredComment("c1", COMMIT_A, "one")],
				resolutions: [resolvable("c1")],
			});
			renderPanel();
			await flush();

			expect(fileBarOf("src/main.ts")).toHaveStyle({
				position: "sticky",
				top: "calc(2 * var(--bar-h))",
			});
		});

		it("scrolls a card the keys reach to below the pinned branch, commit and file", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [lineAnchoredComment("c1", COMMIT_A, "one")],
				resolutions: [resolvable("c1")],
			});
			const { container } = renderPanel();
			await flush();

			expect(container.querySelector(".review-body")).toHaveStyle({
				"scroll-padding-top": "calc(2 * var(--bar-h) + var(--control-sm-h))",
			});
		});
	});

	describe("folding", () => {
		function twoCommitsWithThreads() {
			installReads({
				commits: [
					aSessionCommit({
						oid: COMMIT_A,
						short_oid: "aaaaaaa",
						lane_ref: main,
					}),
					aSessionCommit({
						oid: COMMIT_B,
						short_oid: "bbbbbbb",
						lane_ref: main,
					}),
				],
				comments: [
					lineAnchoredComment("a1", COMMIT_A, "on the first"),
					commitLevelComment("a2", COMMIT_A, "a note on the first"),
					lineAnchoredComment("b1", COMMIT_B, "on the second"),
				],
			});
		}

		function commit(shortOid: string): HTMLElement {
			return screen.getByRole("listitem", { name: `Commit ${shortOid}` });
		}

		it("folds a commit's threads and notes away under its bar", async () => {
			twoCommitsWithThreads();
			renderPanel();
			await flush();

			await fireEvent.click(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Collapse commit",
				}),
			);

			expect(screen.getByText("on the first")).not.toBeVisible();
			expect(screen.getByText("a note on the first")).not.toBeVisible();
			expect(screen.getByText("on the second")).toBeVisible();
		});

		it("unfolds a folded commit from its bar", async () => {
			twoCommitsWithThreads();
			renderPanel();
			await flush();
			const bar = within(commit("aaaaaaa"));
			await fireEvent.click(
				bar.getByRole("button", { name: "Collapse commit" }),
			);

			await fireEvent.click(bar.getByRole("button", { name: "Expand commit" }));

			expect(screen.getByText("on the first")).toBeVisible();
		});

		it("folds a file's threads away under its bar, leaving the commit's notes", async () => {
			twoCommitsWithThreads();
			renderPanel();
			await flush();

			await fireEvent.click(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Collapse file",
				}),
			);

			expect(screen.getByText("on the first")).not.toBeVisible();
			expect(screen.getByText("a note on the first")).toBeVisible();
		});

		function done(thread: Thread): Thread {
			return { ...thread, state: "done", allowed_transitions: ["open"] };
		}

		it("starts a commit whose threads are all settled folded", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [
					done(lineAnchoredComment("a1", COMMIT_A, "on the first")),
					{
						...commitLevelComment("a2", COMMIT_A, "a note on the first"),
						state: "dismissed",
						allowed_transitions: ["open"],
					},
				],
			});

			renderPanel();
			await flush();

			expect(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Expand commit",
				}),
			).toHaveAttribute("aria-expanded", "false");
			expect(screen.getByText("a note on the first")).not.toBeVisible();
		});

		it("leaves a commit open while one of its threads needs the user", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [
					done(lineAnchoredComment("a1", COMMIT_A, "on the first")),
					commitLevelComment("a2", COMMIT_A, "a note on the first"),
				],
			});

			renderPanel();
			await flush();

			expect(screen.getByText("a note on the first")).toBeVisible();
		});

		it("starts a settled file folded under a commit that still needs the user", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [
					done(lineAnchoredComment("a1", COMMIT_A, "on the first")),
					commitLevelComment("a2", COMMIT_A, "a note on the first"),
				],
			});

			renderPanel();
			await flush();

			expect(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Expand file",
				}),
			).toHaveAttribute("aria-expanded", "false");
		});

		it("unfolds a settled commit from its bar", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [
					done(commitLevelComment("a2", COMMIT_A, "a note on the first")),
				],
			});
			renderPanel();
			await flush();

			await fireEvent.click(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Expand commit",
				}),
			);

			expect(screen.getByText("a note on the first")).toBeVisible();
		});

		it("keeps a commit open when its last thread settles under the reader", async () => {
			const note = commitLevelComment("a2", COMMIT_A, "a note on the first");
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [note],
			});
			renderPanel();
			await flush();

			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [done(note)],
			});
			await flush();

			expect(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Collapse commit",
				}),
			).toHaveAttribute("aria-expanded", "true");
		});

		it("unfolds a settled commit when one of its threads reopens", async () => {
			const note = commitLevelComment("a2", COMMIT_A, "a note on the first");
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [done(note)],
			});
			renderPanel();
			await flush();

			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [note],
			});
			await flush();

			expect(screen.getByText("a note on the first")).toBeVisible();
		});

		it("passes J and K over the threads a folded commit hides", async () => {
			twoCommitsWithThreads();
			renderPanel();
			await flush();
			await fireEvent.click(
				within(commit("aaaaaaa")).getByRole("button", {
					name: "Collapse commit",
				}),
			);

			await fireEvent.keyDown(window, { key: "j" });
			await flush();

			expect(
				document.querySelector("article[aria-current='true']"),
			).toHaveTextContent("on the second");
		});
	});

	describe("the note composer", () => {
		async function openComposer() {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				reviews: [aReview({ title: "Pass one" })],
			});
			renderPanel();
			await flush();
			await fireEvent.click(screen.getByRole("button", { name: "Add note" }));
			await flush();
		}

		it("names the commit and the review the note lands in", async () => {
			await openComposer();

			expect(
				within(
					screen.getByRole("group", { name: "Note on aaaaaaa" }),
				).getByText("Pass one"),
			).toBeInTheDocument();
		});

		it("adds the note on Cmd-Enter", async () => {
			await openComposer();
			const field = screen.getByPlaceholderText(
				"Whole-commit note… Markdown supported",
			);
			await fireEvent.input(field, { target: { value: "ship it" } });

			await fireEvent.keyDown(field, { key: "Enter", metaKey: true });
			await flush();

			expect(callArgs("add_commit_thread")).toEqual({
				path: "/repo",
				commitOid: COMMIT_A,
				text: "ship it",
				delivery: "send",
			});
		});

		it("closes on Escape", async () => {
			await openComposer();

			await fireEvent.keyDown(
				screen.getByPlaceholderText("Whole-commit note… Markdown supported"),
				{ key: "Escape" },
			);
			await flush();

			expect(screen.queryByText("Note on aaaaaaa")).not.toBeInTheDocument();
		});
	});
});

describe("ReviewPanel keyboard", () => {
	const main: RefLabel = {
		name: "refs/heads/main",
		short_name: "main",
		ref_type: "LocalBranch",
		is_head: true,
		color_index: 0,
	};

	function renderPanel(
		onJump: (thread: Thread) => void = vi.fn(),
		keysActive = true,
	) {
		return render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump,
				onJumpToCommit: vi.fn(),
				headBranch: "main",
				keysActive,
			},
		});
	}

	async function aCommitWithANoteAndALineThread() {
		installReads({
			commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
			comments: [
				lineAnchoredComment("line", COMMIT_A, "on the lines"),
				commitLevelComment("note", COMMIT_A, "on the commit"),
			],
		});
	}

	async function press(key: string) {
		await fireEvent.keyDown(window, { key });
		await flush();
	}

	function focusedThread(): HTMLElement | null {
		return document.querySelector<HTMLElement>("article[aria-current='true']");
	}

	it("moves through the threads in the order the panel shows them with J and K", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");
		const first = focusedThread()?.textContent;
		await press("j");
		const second = focusedThread()?.textContent;
		await press("k");

		expect([first, second, focusedThread()?.textContent]).toEqual([
			expect.stringContaining("on the commit"),
			expect.stringContaining("on the lines"),
			expect.stringContaining("on the commit"),
		]);
	});

	it("stays on the first thread when K is pressed at the top", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");
		await press("j");
		for (const _ of [1, 2, 3, 4, 5]) await press("k");

		expect(focusedThread()).toHaveTextContent("on the commit");
	});

	it("focuses a thread the user clicks into", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await fireEvent.pointerDown(screen.getByText("on the lines"));

		expect(focusedThread()).toHaveTextContent("on the lines");
	});

	it("marks the thread J moves to, so the keys show where they are", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");

		expect(focusedThread()).toHaveClass("comment-card-cursor");
	});

	it("leaves a thread the pointer pressed unmarked, since the pointer shows where it is", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();
		await press("j");

		await fireEvent.pointerDown(screen.getByText("on the lines"));

		expect(focusedThread()).not.toHaveClass("comment-card-cursor");
	});

	it("marks the thread again once J moves on from a pressed one", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();
		await fireEvent.pointerDown(screen.getByText("on the commit"));

		await press("j");

		expect(focusedThread()).toHaveClass("comment-card-cursor");
	});

	it("marks the focused thread done with D", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");
		await press("d");

		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "note",
			next: "done",
		});
	});

	it("dismisses the focused thread with X", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");
		await press("x");

		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "note",
			next: "dismissed",
		});
	});

	it("reopens a finished thread with O", async () => {
		installReads({
			commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
			comments: [
				aThread({
					id: "finished",
					commit_oid: COMMIT_A,
					state: "done",
					allowed_transitions: ["open"],
				}),
			],
		});
		renderPanel();
		await flush();
		await fireEvent.click(
			screen.getByRole("button", { name: "Expand commit" }),
		);

		await press("j");
		await press("o");

		expect(callArgs("set_thread_state")).toEqual({
			path: "/repo",
			id: "finished",
			next: "open",
		});
	});

	it("opens the focused thread's code with Enter", async () => {
		await aCommitWithANoteAndALineThread();
		const onJump = vi.fn();
		renderPanel(onJump);
		await flush();

		await press("j");
		await press("j");
		await press("Enter");

		expect(onJump).toHaveBeenCalledWith(
			expect.objectContaining({ id: "line" }),
		);
	});

	it("opens a current-file thread's code with Enter", async () => {
		installReads({
			commits: [],
			comments: [currentFileComment("pinned", "on the file")],
			resolutions: [resolvable("pinned")],
		});
		const onJump = vi.fn();
		renderPanel(onJump);
		await flush();

		await press("j");
		await press("Enter");

		expect(onJump).toHaveBeenCalledWith(
			expect.objectContaining({ id: "pinned" }),
		);
	});

	it("lets a current-file thread's lines open its code", async () => {
		installReads({
			commits: [],
			comments: [currentFileComment("pinned", "on the file")],
			resolutions: [resolvable("pinned")],
		});
		renderPanel();
		await flush();

		expect(screen.getByRole("button", { name: "Line 4" })).toBeEnabled();
	});

	it("leaves Enter to a button that has focus", async () => {
		await aCommitWithANoteAndALineThread();
		const onJump = vi.fn();
		renderPanel(onJump);
		await flush();
		await press("j");
		await press("j");
		screen.getAllByRole("button", { name: "Mark done" })[0].focus();

		await press("Enter");

		expect(onJump).not.toHaveBeenCalled();
	});

	it("leaves Enter to the reply field it was typed into", async () => {
		await aCommitWithANoteAndALineThread();
		const onJump = vi.fn();
		renderPanel(onJump);
		await flush();
		await press("j");
		await press("j");
		const cards = screen.getAllByRole("article");
		const reply = within(cards[cards.length - 1]).getByLabelText("Reply");

		await fireEvent.keyDown(reply, { key: "Enter" });

		expect(onJump).not.toHaveBeenCalled();
	});

	it("puts the cursor in the focused thread's reply box with R", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		await press("j");
		await press("r");

		const focused = focusedThread();
		expect(document.activeElement).toBe(
			focused && within(focused).getByRole("textbox", { name: "Reply" }),
		);
	});

	it("names the keys under the threads", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();

		const legend = screen.getByRole("note", { name: "Keyboard shortcuts" });

		expect(legend.textContent?.replace(/\s/g, "")).toBe(
			"JKmove↵opencodeRreplyDdoneXdismissOreopen",
		);
	});

	// Every repo tab keeps its panel mounted, and the window hears every key.
	it("leaves the keys alone while its tab is hidden", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel(vi.fn(), false);
		await flush();

		await press("j");

		expect(focusedThread()).toBeNull();
	});

	it("keeps the keys while focus sits in the reviews list", async () => {
		await aCommitWithANoteAndALineThread();
		const reviewList = document.createElement("nav");
		const row = document.createElement("button");
		reviewList.append(row);
		document.body.append(reviewList);
		render(ReviewPanel, {
			props: {
				repoPath: "/repo",
				session: createReviewSession(),
				reviewComments,
				onJump: vi.fn(),
				onJumpToCommit: vi.fn(),
				headBranch: "main",
				reviewList,
			},
		});
		await flush();
		row.focus();

		await fireEvent.keyDown(row, { key: "j" });
		await flush();
		reviewList.remove();

		expect(focusedThread()).not.toBeNull();
	});

	it("leaves the keys to a control outside the panel", async () => {
		await aCommitWithANoteAndALineThread();
		renderPanel();
		await flush();
		const elsewhere = document.createElement("button");
		document.body.append(elsewhere);
		elsewhere.focus();

		await fireEvent.keyDown(elsewhere, { key: "j" });
		await flush();
		elsewhere.remove();

		expect(focusedThread()).toBeNull();
	});

	describe("when the user is typing", () => {
		it("leaves the keys to the text", async () => {
			await aCommitWithANoteAndALineThread();
			renderPanel();
			await flush();
			await press("j");
			const reply = within(focusedThread() as HTMLElement).getByRole(
				"textbox",
				{ name: "Reply" },
			);
			reply.focus();

			await fireEvent.keyDown(reply, { key: "d" });
			await flush();

			expect(calledCommands()).not.toContain("set_thread_state");
		});
	});

	describe("when the focused thread cannot take the step", () => {
		it("does nothing", async () => {
			installReads({
				commits: [aSessionCommit({ oid: COMMIT_A, lane_ref: main })],
				comments: [
					aThread({
						id: "finished",
						commit_oid: COMMIT_A,
						state: "done",
						allowed_transitions: ["open"],
					}),
				],
			});
			renderPanel();
			await flush();

			await press("j");
			await press("x");

			expect(calledCommands()).not.toContain("set_thread_state");
		});
	});
});
