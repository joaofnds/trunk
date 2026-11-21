import { setImmediate } from "node:timers/promises";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { makeCommit, makeMergeSides } from "../__tests__/helpers/factories.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { aReview } from "../__tests__/helpers/review-fixture.js";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { getCommitDraft } from "../lib/store.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import type { CommitDetail, FileDiff } from "../lib/types.js";
import RepoView from "./RepoView.svelte";

let host: RepositoryReadHost;

beforeEach(() => {
	_resetToasts();
	host = new RepositoryReadHost();
	host.install();
	installDomPolyfills({ viewportHeight: 200 });
});

afterEach(() => {
	vi.useRealTimers();
	_resetToasts();
	cleanup();
	host.dispose();
	restoreDomPolyfills();
});

describe("RepoView staging selection", () => {
	it.each([true, false])(
		"finishes loading another file when an older hunk action completes (changes left: %s)",
		async (fileStillChanged) => {
			const one = loadedFile("one", "first file content");
			const two = loadedFile("two", "second file content");
			host.seedResponse("get_status", {
				unstaged: [one, two],
				staged: [],
				conflicted: [],
			});
			host.seedResponse("diff_unstaged", [one]);
			await openRepository();
			await fireEvent.click(await screen.findByText(one.path));
			const action = host.holdNextReply("stage_hunk");
			await clickStageHunk();
			await action.entered;
			const nextDiff = host.holdNextReply("diff_unstaged");
			await fireEvent.click(screen.getByText(two.path));
			await nextDiff.entered;

			host.seedResponse("get_status", {
				unstaged: fileStillChanged ? [one, two] : [two],
				staged: [one],
				conflicted: [],
			});
			action.release({ file_still_changed: fileStillChanged });
			await drainReplies();
			nextDiff.release([two]);
			await drainReplies();

			expect(screen.getByText("second file content")).toBeVisible();
			expect(screen.queryByText("Loading diff…")).toBeNull();
			expect(
				within(screen.getByTestId("staging-staged-section")).getByText(
					one.path,
				),
			).toBeVisible();
		},
	);

	it("refreshes the newly selected staged side when a hunk leaves the unstaged side", async () => {
		const file = loadedFile("one", "unstaged content");
		const neighbor = loadedFile("neighbor", "neighbor content");
		host.seedResponse("get_status", {
			unstaged: [file],
			staged: [file, neighbor],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [file]);
		host.seedResponse("diff_staged", [
			loadedFile("one", "original staged content"),
		]);
		await openRepository();
		const unstaged = within(
			await screen.findByTestId("staging-unstaged-section"),
		);
		const staged = within(screen.getByTestId("staging-staged-section"));
		await fireEvent.click(await unstaged.findByText(file.path));
		const action = host.holdNextReply("stage_hunk");
		await clickStageHunk();
		await action.entered;
		await fireEvent.click(staged.getByText(file.path));
		await screen.findByText("original staged content");

		host.seedResponse("get_status", {
			unstaged: [],
			staged: [file, neighbor],
			conflicted: [],
		});
		host.seedResponse("diff_staged", [
			loadedFile("one", "updated staged content"),
		]);
		action.release({ file_still_changed: false });
		await drainReplies();

		expect(screen.getByTestId("diff-path")).toHaveTextContent(file.path);
		expect(screen.getByText("updated staged content")).toBeVisible();
		expect(staged.getByText(file.path)).toBeVisible();
		expect(unstaged.queryByText(file.path)).toBeNull();
	});

	it("follows a reopened file to the other side when its older hunk action empties it", async () => {
		const one = loadedFile("one", "first file content");
		const two = loadedFile("two", "second file content");
		host.seedResponse("get_status", {
			unstaged: [one, two],
			staged: [],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [one]);
		await openRepository();
		const unstaged = within(
			await screen.findByTestId("staging-unstaged-section"),
		);
		await fireEvent.click(await unstaged.findByText(one.path));
		const action = host.holdNextReply("stage_hunk");
		await clickStageHunk();
		await action.entered;
		host.seedResponse("diff_unstaged", [two]);
		await fireEvent.click(unstaged.getByText(two.path));
		await screen.findByText("second file content");
		host.seedResponse("diff_unstaged", [one]);
		await fireEvent.click(unstaged.getByText(one.path));
		await screen.findByText("first file content");

		host.seedResponse("get_status", {
			unstaged: [two],
			staged: [one],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [two]);
		host.seedResponse("diff_staged", [
			loadedFile("one", "staged first file content"),
		]);
		action.release({ file_still_changed: false });
		await drainReplies();

		expect(screen.getByText("staged first file content")).toBeVisible();
		expect(screen.queryByText("second file content")).toBeNull();
	});

	it("keeps the lines selected in a different file when an older line action completes", async () => {
		const one = loadedFile("one", "first file content");
		const two = loadedFile("two", "second file content");
		host.seedResponse("get_status", {
			unstaged: [one, two],
			staged: [],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [one]);
		await openRepository();
		await fireEvent.click(await screen.findByText(one.path));
		await selectChangedLine("first file content");
		const action = host.holdNextReply("stage_lines");
		await fireEvent.click(
			screen.getByRole("button", { name: "Stage Lines (1)" }),
		);
		await action.entered;
		host.seedResponse("diff_unstaged", [two]);
		await fireEvent.click(screen.getByText(two.path));
		await selectChangedLine("second file content");

		action.release({ file_still_changed: true });
		await drainReplies();

		expect(screen.getByTestId("diff-path")).toHaveTextContent(two.path);
		expect(
			screen.getByRole("button", { name: "Stage Lines (1)" }),
		).toBeEnabled();
	});

	it("keeps a pending branch navigation when an older hunk action empties its file", async () => {
		const one = loadedFile("one", "first file content");
		const two = loadedFile("two", "second file content");
		seedBranch();
		host.seedResponse("get_status", {
			unstaged: [one, two],
			staged: [],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [one]);
		await openRepository();
		await fireEvent.click(await screen.findByText(one.path));
		const action = host.holdNextReply("stage_hunk");
		await clickStageHunk();
		await action.entered;
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;

		host.seedResponse("get_status", {
			unstaged: [two],
			staged: [one],
			conflicted: [],
		});
		host.seedResponse("diff_staged", [loadedFile("one", "staged content")]);
		action.release({ file_still_changed: false });
		await screen.findByText("staged content");
		seedCommit("first");
		ref.release("first");

		expect(await screen.findByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
	});

	async function clickStageHunk() {
		await vi.dynamicImportSettled();
		await fireEvent.click(
			await screen.findByRole("button", { name: "Stage Hunk" }),
		);
	}

	async function selectChangedLine(content: string) {
		const line = await screen.findByText(content);
		const grip = line
			.closest(".diff-line")
			?.querySelector("[data-gutter-grip]");
		if (!grip) throw new Error("diff line has no gutter grip");

		await fireEvent.mouseDown(grip);
		await fireEvent.mouseUp(window);
	}

	it.each([
		["unstaged", "staged", "Unstage Hunk"],
		["staged", "unstaged", "Stage Hunk"],
	] as const)(
		"hides the %s hunks while the same file's %s diff loads",
		async (from, to, action) => {
			const file = {
				path: "working.txt",
				status: "Modified",
				is_binary: false,
			};
			host.seedResponse("get_status", {
				unstaged: [file],
				staged: [file],
				conflicted: [],
			});
			host.seedResponse(`diff_${from}`, [
				loadedFile("working", "previous side"),
			]);
			await openRepository();
			const fromSection = within(screen.getByTestId(`staging-${from}-section`));
			const toSection = within(screen.getByTestId(`staging-${to}-section`));
			await fireEvent.click(await fromSection.findByText(file.path));
			await screen.findByText("previous side");
			const pending = host.holdNextReply(`diff_${to}`);

			await fireEvent.click(toSection.getByText(file.path));
			await pending.entered;

			expect(screen.queryByText("previous side")).toBeNull();
			expect(screen.queryByRole("button", { name: action })).toBeNull();
			expect(screen.getByText("Loading diff…")).toBeVisible();

			pending.release([loadedFile("working", "selected side")]);

			expect(await screen.findByText("selected side")).toBeVisible();
			expect(screen.getByRole("button", { name: action })).toBeVisible();
		},
	);
});

describe("review file finder", () => {
	it("preserves the query through startup review hydration", async () => {
		const restored = aReview({ title: "Restored review" });
		const other = aReview({ id: "OTHER001", title: "Other review" });
		host.seedResponse("list_reviews", [restored, other]);
		host.seedResponse("get_active_review", restored.id);
		const initialReview = host.holdNextReply("get_active_review");
		const view = await openRepository();
		await initialReview.entered;
		await view.rerender({ reviewActive: true });
		const files = host.holdNextReply("list_tracked_files");
		await fireEvent.click(await screen.findByText(/Comment on a file/));
		await files.entered;
		const input = screen.getByRole("combobox", { name: /Find a tracked file/ });
		await fireEvent.input(input, { target: { value: "second" } });

		initialReview.release(restored.id);
		await drainReplies();
		files.release([
			{ path: "first.txt", changed: false },
			{ path: "second.txt", changed: false },
		]);

		expect(input).toHaveFocus();
		expect(input).toHaveValue("second");
		expect(
			await screen.findByRole("option", { name: "second.txt" }),
		).toBeVisible();
		expect(screen.queryByRole("option", { name: "first.txt" })).toBeNull();

		await fireEvent.click(
			screen.getByRole("button", { name: `Show review ${other.id}` }),
		);

		expect(
			screen.queryByRole("combobox", { name: /Find a tracked file/ }),
		).toBeNull();
	});

	it("accepts a query while the tracked files are loading", async () => {
		const view = await openRepository();
		await view.rerender({ reviewActive: true });
		const files = host.holdNextReply("list_tracked_files");
		await fireEvent.click(await screen.findByText(/Comment on a file/));
		await files.entered;

		const input = screen.getByRole("combobox", { name: /Find a tracked file/ });
		expect(input).toHaveFocus();
		await fireEvent.input(input, { target: { value: "second" } });
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		files.release([
			{ path: "first.txt", changed: false },
			{ path: "second.txt", changed: false },
		]);

		expect(
			await screen.findByRole("option", { name: "second.txt", selected: true }),
		).toBeVisible();
		expect(screen.queryByRole("option", { name: "first.txt" })).toBeNull();
		expect(input).toHaveFocus();
	});

	it("keeps a dismissed finder closed when an older listing fails", async () => {
		const view = await openRepository();
		await view.rerender({ reviewActive: true });
		const files = host.holdNextReply("list_tracked_files");
		await fireEvent.click(await screen.findByText(/Comment on a file/));
		await files.entered;

		await fireEvent.keyDown(
			screen.getByRole("combobox", { name: /Find a tracked file/ }),
			{ key: "Escape" },
		);
		files.reject({ code: "not_open", message: "Repository closed" });
		await drainReplies();

		expect(
			screen.queryByRole("dialog", { name: "Comment on a file" }),
		).toBeNull();
		expect(toasts.items).toEqual([]);
	});

	it("drops an older listing when leaving and returning to the review tab", async () => {
		const view = await openRepository();
		await view.rerender({ reviewActive: true });
		const older = host.holdNextReply("list_tracked_files");
		await fireEvent.click(await screen.findByText(/Comment on a file/));
		await older.entered;

		await view.rerender({ tabActive: false, reviewActive: false });
		await view.rerender({ tabActive: true, reviewActive: true });
		host.seedResponse("list_tracked_files", [
			{ path: "current.txt", changed: false },
		]);
		await fireEvent.click(await screen.findByText(/Comment on a file/));
		const input = screen.getByRole("combobox", { name: /Find a tracked file/ });
		await screen.findByRole("option", { name: "current.txt" });
		older.release([{ path: "stale.txt", changed: false }]);
		await drainReplies();

		expect(screen.queryByRole("option", { name: "stale.txt" })).toBeNull();
		expect(screen.getByRole("option", { name: "current.txt" })).toBeVisible();
		expect(input).toHaveFocus();
	});
});

describe("RepoView commit selection", () => {
	it("keeps a newer comparison after an older ref lookup resolves", async () => {
		seedBranch();
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;
		await compareCommit("first", "third");

		seedCommit("second");
		ref.release("second");
		await drainReplies();

		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"first change",
		);
		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"third change",
		);
	});

	it("keeps a newer comparison-file selection after an older ref lookup resolves", async () => {
		seedBranch();
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await compareCommit("first", "third", [fileDiff("comparison")]);
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;
		host.seedResponse("diff_compare_file", [fileDiff("comparison")]);
		await fireEvent.click(screen.getByText("comparison.txt"));
		await screen.findByText("comparison file content");

		seedCommit("second");
		ref.release("second");
		await drainReplies();

		expect(screen.getByText("comparison file content")).toBeVisible();
		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"third change",
		);
	});

	describe("comparison file content mode", () => {
		it("renders the comparison revisions after leaving a current-file review", async () => {
			const markdown = { ...fileDiff("comparison"), path: "guide.md" };
			host.seedResponse("list_tracked_files", [
				{ path: "current.txt", changed: false },
			]);
			host.seedResponse("open_current_file", [fileDiff("current")]);
			host.seedResponse("diff_compare_file", [markdown]);
			const view = await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");
			await compareCommit("first", "third", [markdown]);

			await view.rerender({ reviewActive: true });
			await fireEvent.click(await screen.findByText(/Comment on a file/));
			await fireEvent.click(
				await screen.findByRole("option", { name: "current.txt" }),
			);
			await screen.findByText("current file content");
			await view.rerender({ reviewActive: false });
			await fireEvent.click(await screen.findByText("guide.md"));
			const rendered = host.holdNextReply("render_markdown_diff");
			await fireEvent.click(await screen.findByTitle("Show rendered markdown"));

			expect(await rendered.entered).toMatchObject({
				beforeRev: { type: "commit", oid: "first" },
				afterRev: { type: "commit", oid: "third" },
			});
			rendered.release({ rows: [], changedLines: [], whitespaceOnly: false });
		});

		it("hides a retained comparison hunk payload while that file's full content loads", async () => {
			const view = await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");
			await compareCommit("first", "third", [hunkless("one"), hunkless("two")]);
			await openComparisonFile("one", "one hunk");
			await openComparisonFile("two", "two hunk");
			host.seedResponse("diff_compare_file", [loadedFile("two", "two full")]);
			await view.rerender({ contentMode: "full" });
			await screen.findByText("two full");
			const pending = host.holdNextReply("diff_compare_file");

			await fireEvent.click(screen.getByText("one.txt"));
			await pending.entered;

			expect(screen.queryByText("one hunk")).toBeNull();
			expect(screen.getByText("Loading diff…")).toBeTruthy();
		});

		it("keeps a comparison file on screen while it reloads in the same mode", async () => {
			await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");
			await compareCommit("first", "third", [hunkless("one")]);
			await openComparisonFile("one", "one original");
			const pending = host.holdNextReply("diff_compare_file");

			await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
			await pending.entered;

			expect(screen.getByText("one original")).toBeVisible();
		});
	});

	it("keeps a comparison swap after an older ref lookup resolves", async () => {
		seedBranch();
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await compareCommit("first", "third");
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;
		const base = host.holdNextReply("get_commit_detail");
		const target = host.holdNextReply("get_commit_detail");
		await fireEvent.click(
			screen.getByRole("button", { name: "Swap comparison direction" }),
		);
		await base.entered;
		await target.entered;
		base.release(detailFor("third"));
		target.release(detailFor("first"));
		await drainReplies();

		seedCommit("second");
		ref.release("second");
		await drainReplies();

		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"third change",
		);
		expect(
			host.requests.filter(({ cmd }) => cmd === "list_compare_files").at(-1)
				?.args,
		).toMatchObject({ baseOid: "third", targetOid: "first" });
	});

	it("keeps a comparison closed after an older ref lookup resolves", async () => {
		seedBranch();
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await compareCommit("first", "third");
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;
		await fireEvent.click(
			screen.getByRole("button", { name: "Close comparison" }),
		);
		await screen.findByText("first.txt");

		seedCommit("second");
		ref.release("second");
		await drainReplies();

		expect(screen.queryByTestId("compare-header")).toBeNull();
		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
	});

	it("finishes pending anchor metadata while a comparison owns navigation", async () => {
		await openRepository();
		const anchor = host.holdNextReply("get_commit_detail");
		await selectCommit("first");
		await anchor.entered;
		await compareCommit("first", "third");

		anchor.release(detailFor("first"));
		await drainReplies();
		await fireEvent.click(
			screen.getByRole("button", { name: "Close comparison" }),
		);

		expect(await screen.findByText("first.txt")).toBeVisible();
		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
	});

	it("keeps a newer row selection after an older ref lookup resolves", async () => {
		seedBranch();
		await openRepository();
		const ref = host.holdNextReply("resolve_ref");
		await fireEvent.click(await screen.findByText("topic"));
		await ref.entered;
		await selectCommit("second");
		await screen.findByText("second.txt");

		seedCommit("first");
		ref.release("first");
		await drainReplies();

		expect(commitRow("second")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"second change",
		);
	});

	it("does not scroll an obsolete ref selection after its metadata finishes", async () => {
		seedBranch();
		const view = await openRepository();
		const scrolls = recordGraphScrolls(view.container);
		const detail = host.holdNextReply("get_commit_detail");
		seedCommit("first");
		await fireEvent.click(await screen.findByText("topic"));
		await detail.entered;
		await selectCommit("second");
		await screen.findByText("second.txt");

		detail.release(detailFor("first"));
		await drainReplies();

		expect(scrolls).toEqual([]);
		expect(commitRow("second")).toHaveAttribute("aria-selected", "true");
	});

	it("keeps the selected commit when its ref is clicked again", async () => {
		seedBranch();
		await openRepository();
		seedCommit("first");
		await fireEvent.click(await screen.findByText("topic"));
		await screen.findByText("first.txt");

		await fireEvent.click(screen.getByText("topic"));
		await drainReplies();

		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
		expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
	});

	it("shows the open diff over the review panel when the selected commit's ref is clicked", async () => {
		seedBranch();
		const view = await openRepository();
		seedCommit("first");
		await fireEvent.click(await screen.findByText("topic"));
		await fireEvent.click(await screen.findByText("first.txt"));
		await screen.findByText("first file content");
		await view.rerender({ reviewActive: true });
		const reviewPanelPrompt = await screen.findByText(/Comment on a file/);

		await fireEvent.click(screen.getByText("topic"));
		await drainReplies();

		expect(reviewPanelPrompt).not.toBeVisible();
		expect(screen.getByText("first file content")).toBeVisible();
	});

	it("does not scroll an obsolete review jump after its metadata finishes", async () => {
		host.seedResponse("list_session_commits", [
			aSessionCommit({
				oid: "first",
				short_oid: "first",
				summary: "first change",
			}),
		]);
		const view = await openRepository();
		await view.rerender({
			reviewActive: true,
			onleavereview: () => void view.rerender({ reviewActive: false }),
		});
		const detail = host.holdNextReply("get_commit_detail");
		seedCommit("first");
		await fireEvent.click(await screen.findByLabelText("Jump to commit first"));
		await detail.entered;
		await screen.findAllByTestId("commit-row");
		const scrolls = recordGraphScrolls(view.container);
		await selectCommit("second");
		await screen.findByText("second.txt");

		detail.release(detailFor("first"));
		await drainReplies();

		expect(scrolls).toEqual([]);
		expect(commitRow("second")).toHaveAttribute("aria-selected", "true");
	});

	it("keeps a ref navigation that is still resolving when the search answers", async () => {
		seedBranch();
		await openRepository();
		const searchReply = host.holdNextReply("search_commits");
		const ref = host.holdNextReply("resolve_ref");
		await startSearch("change");
		await searchReply.entered;

		await fireEvent.click(screen.getByText("topic"));
		await ref.entered;
		seedCommit("second");
		searchReply.release([{ oid: "second" }]);
		await drainReplies();

		expect(screen.getByText("1 of 1")).toBeVisible();
		expect(commitRow("second")).toHaveAttribute("aria-selected", "false");
		seedCommit("first");
		ref.release("first");
		expect(await screen.findByText("first.txt")).toBeVisible();
	});

	it("keeps the detail pane cleared when a search answers after Escape", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const searchReply = host.holdNextReply("search_commits");
		await startSearch("change");
		await searchReply.entered;
		seedCommit("second");

		screen.getByPlaceholderText("Search commits…").blur();
		await fireEvent.keyDown(window, { key: "Escape" });
		searchReply.release([{ oid: "second" }]);
		await drainReplies();

		expect(screen.getByText("1 of 1")).toBeVisible();
		expect(screen.queryByTestId("commit-detail")).toBeNull();
	});

	it.each(["Next match", "Enter"])(
		"keeps the sole search result selected after $0",
		async (gesture) => {
			await openRepository();
			seedCommit("first");
			host.seedResponse("search_commits", [{ oid: "first" }]);
			await host.emit("search-toggle", null);
			const search = await screen.findByPlaceholderText("Search commits…");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			await fireEvent.input(search, { target: { value: "first" } });
			await vi.advanceTimersByTimeAsync(200);
			vi.useRealTimers();
			await screen.findByText("first.txt");

			if (gesture === "Enter")
				await fireEvent.keyDown(search, { key: "Enter" });
			else
				await fireEvent.click(
					screen.getByRole("button", { name: "Next match" }),
				);
			await drainReplies();

			expect(screen.getByTestId("commit-detail")).toHaveTextContent(
				"first change",
			);
			expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
		},
	);

	it("shows usable files and details before optional statistics finish", async () => {
		const statistics = host.holdNextReply("commit_stat");
		await openRepository();

		await selectCommit("first");
		await statistics.entered;

		expect(await screen.findByText("first.txt")).toBeVisible();
		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
		expect(
			within(screen.getByTestId("commit-detail")).queryByText("+17"),
		).toBeNull();
	});

	it("opens the selected commit's file while its statistics are pending", async () => {
		host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");

		await fireEvent.click(await screen.findByText("first.txt"));

		expect(await screen.findByText("first file content")).toBeVisible();
	});

	it("adds statistics to the already usable selected commit", async () => {
		const statistics = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");

		statistics.release({ files_changed: 1, insertions: 17, deletions: 2 });

		expect(
			await within(screen.getByTestId("commit-detail")).findByText("+17"),
		).toBeVisible();
	});

	it("keeps the previous selection coherent until the next metadata arrives", async () => {
		await openRepository();
		await selectCommit("first");
		await within(await screen.findByTestId("commit-detail")).findByText("+17");
		const files = host.holdNextReply("list_commit_files");

		await selectCommit("second");
		await files.entered;
		await drainReplies();

		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
		expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
		expect(commitRow("second")).toHaveAttribute("aria-selected", "false");
	});

	it("keeps a newer working-file selection when pending commit metadata arrives", async () => {
		host.seedResponse("get_status", {
			unstaged: [{ path: "working.txt", status: "Modified", is_binary: false }],
			staged: [],
			conflicted: [],
		});
		host.seedResponse("diff_unstaged", [fileDiff("working")]);
		await openRepository();
		await screen.findByText("working.txt");
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("first");
		await detail.entered;

		await fireEvent.click(screen.getByText("working.txt"));
		await screen.findByText("working file content");
		detail.release(detailFor("first"));
		await drainReplies();

		expect(screen.getByText("working file content")).toBeVisible();
		expect(screen.queryByTestId("commit-detail")).toBeNull();
	});

	it("keeps a newly opened displayed-commit file when pending metadata arrives", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("second");
		await detail.entered;
		host.seedResponse("diff_commit_file", [fileDiff("first")]);

		await fireEvent.click(screen.getByText("first.txt"));
		await screen.findByText("first file content");
		detail.release(detailFor("second"));
		await drainReplies();

		expect(screen.getByText("first file content")).toBeVisible();
		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
	});

	it("keeps a current-source file selected after pending commit metadata arrives", async () => {
		host.seedResponse("list_tracked_files", [
			{ path: "current.txt", changed: false },
		]);
		host.seedResponse("open_current_file", [fileDiff("current")]);
		const view = await openRepository();
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("first");
		await detail.entered;
		await view.rerender({ reviewActive: true });
		await fireEvent.click(await screen.findByText(/Comment on a file/));

		await fireEvent.click(
			await screen.findByRole("option", { name: "current.txt" }),
		);
		await screen.findByText("current file content");
		detail.release(detailFor("first"));
		await drainReplies();
		await view.rerender({ reviewActive: false });
		await screen.findByRole("button", { name: "Commit" });

		expect(screen.getByText("current file content")).toBeVisible();
		expect(screen.queryByTestId("commit-detail")).toBeNull();
	});

	it("compares against the displayed selection from its context menu", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const pending = host.holdNextReply("get_commit_detail");
		await selectCommit("second");
		await pending.entered;
		seedComparison();
		const base = host.holdNextReply("get_commit_detail");
		const target = host.holdNextReply("get_commit_detail");
		await fireEvent.contextMenu(commitRow("second"));
		await waitFor(() =>
			expect(host.contextMenu.items()).toContainEqual({
				label: "Compare with selected commit",
				enabled: true,
			}),
		);

		host.contextMenu.choose("Compare with selected commit");
		await drainReplies();

		expect(
			host.requests.filter(({ cmd }) => cmd === "list_compare_files").at(-1)
				?.args,
		).toMatchObject({ baseOid: "first", targetOid: "second" });
		base.release(detailFor("first"));
		target.release(detailFor("second"));
		await screen.findByTestId("compare-header");
		pending.release(detailFor("second"));
		await drainReplies();
		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"first change",
		);
		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"second change",
		);
	});

	it("keeps a newer comparison when an earlier plain selection finishes", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await compareCommit("first", "second");
		const pending = host.holdNextReply("get_commit_detail");
		await selectCommit("third");
		await pending.entered;
		await compareCommit("third", "fourth");

		pending.release(detailFor("third"));
		await drainReplies();

		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"third change",
		);
		expect(screen.getByTestId("compare-header")).toHaveTextContent(
			"fourth change",
		);
	});

	it.each([
		{ key: "ArrowDown", start: "first", end: "third" },
		{ key: "j", start: "first", end: "third" },
		{ key: "ArrowUp", start: "third", end: "first" },
		{ key: "k", start: "third", end: "first" },
	])(
		"advances twice with $key while metadata is pending",
		async ({ key, start, end }) => {
			await openRepository();
			await selectCommit(start);
			await screen.findByText(`${start}.txt`);
			const second = host.holdNextReply("get_commit_detail");
			const last = host.holdNextReply("get_commit_detail");
			seedCommit("second");
			await pressNavigationKey(key);
			await second.entered;

			seedCommit(end);
			await pressNavigationKey(key);
			const requested = await last.entered;

			expect(requested).toMatchObject({ oid: end });
			last.release(detailFor(end));
			await screen.findByText(`${end}.txt`);
			second.release(detailFor("second"));
			await drainReplies();
			expect(screen.getByTestId("commit-detail")).toHaveTextContent(
				`${end} change`,
			);
			expect(commitRow(end)).toHaveAttribute("aria-selected", "true");
		},
	);

	it("cancels an unfinished step when navigation returns to the displayed commit", async () => {
		await openRepository();
		await selectCommit("first");
		await within(await screen.findByTestId("commit-detail")).findByText("+17");
		const detail = host.holdNextReply("get_commit_detail");
		const statistics = host.holdNextReply("commit_stat");
		seedCommit("second");
		await pressNavigationKey("j");
		await detail.entered;

		await pressNavigationKey("k");
		detail.release(detailFor("second"));
		statistics.release({ files_changed: 1, insertions: 23, deletions: 2 });
		await drainReplies();

		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
		expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
		expect(
			within(screen.getByTestId("commit-detail")).getByText("+17"),
		).toBeVisible();
	});

	it("finishes the displayed commit's statistics after a pending step is cancelled", async () => {
		const statistics = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const detail = host.holdNextReply("get_commit_detail");
		seedCommit("second");
		await pressNavigationKey("j");
		await detail.entered;
		await pressNavigationKey("k");

		statistics.release({ files_changed: 1, insertions: 17, deletions: 2 });
		await drainReplies();

		expect(
			within(screen.getByTestId("commit-detail")).getByText("+17"),
		).toBeVisible();
	});

	it("keeps details closed after an unfinished selection completes", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("second");
		await detail.entered;

		await fireEvent.click(
			screen.getByRole("button", { name: "Close commit detail" }),
		);
		detail.release(detailFor("second"));
		await drainReplies();

		expect(screen.queryByTestId("commit-detail")).toBeNull();
		expect(commitRow("first")).toHaveAttribute("aria-selected", "false");
		expect(commitRow("second")).toHaveAttribute("aria-selected", "false");
	});

	it("keeps a pending target selected when that row is clicked again", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("second");
		await detail.entered;

		await clickCommit("second");
		detail.release(detailFor("second"));
		await drainReplies();

		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"second change",
		);
		expect(commitRow("second")).toHaveAttribute("aria-selected", "true");
	});

	it("returns to the uncommitted changes when their row is clicked", async () => {
		host.seedResponse("get_dirty_counts", {
			staged: 1,
			unstaged: 0,
			conflicted: 0,
		});
		await openRepository();
		const uncommittedChanges = (await screen.findByText("// WIP")).closest(
			'[data-testid="commit-row"]',
		) as HTMLElement;
		await selectCommit("first");
		await screen.findByText("first.txt");

		await fireEvent.click(uncommittedChanges);
		await drainReplies();

		expect(screen.queryByTestId("commit-detail")).toBeNull();
		expect(commitRow("first")).toHaveAttribute("aria-selected", "false");
	});

	describe("the uncommitted changes' message", () => {
		const DRAFT = "fix: draft";

		beforeEach(() => {
			host.seedResponse("get_dirty_counts", {
				staged: 1,
				unstaged: 0,
				conflicted: 0,
			});
		});

		function draftSummary(): HTMLInputElement {
			return screen.getByTestId("commit-form-subject") as HTMLInputElement;
		}

		async function typeDraftSummary(text: string): Promise<void> {
			await screen.findByTestId("commit-form-subject");
			await fireEvent.input(draftSummary(), { target: { value: text } });
		}

		function wipMessage(): Promise<HTMLElement> {
			return screen.findByRole("button", { name: /edit commit summary/ });
		}

		async function clickWipMessage(): Promise<void> {
			await fireEvent.click(await wipMessage());
			await drainReplies();
		}

		it("focuses the draft's summary from a selected commit", async () => {
			await openRepository();
			await typeDraftSummary(DRAFT);
			await selectCommit("first");
			await screen.findByText("first.txt");

			await clickWipMessage();

			expect(document.activeElement).toBe(draftSummary());
			expect(draftSummary().value).toBe(DRAFT);
		});

		it("opens the collapsed detail pane before focusing the draft's summary", async () => {
			const view = await openRepository({ rightPaneCollapsed: true });
			const inertAtFocus: boolean[] = [];
			draftSummary().addEventListener("focus", (e) => {
				const field = e.target as HTMLElement;
				inertAtFocus.push(
					[...ancestorsOf(field)].some((node) => node.inert === true),
				);
			});

			await clickWipMessage();

			expect(view.rightPaneChanges).toEqual([false]);
			expect(inertAtFocus).toEqual([false]);
			expect(document.activeElement).toBe(draftSummary());
		});

		it("shows its pencil while the draft's summary has the focus", async () => {
			await openRepository();

			await clickWipMessage();

			expect(screen.getByTestId("wip-edit-mark")).toHaveClass("text-accent");
		});

		it("keeps an amend being written across a look at a commit", async () => {
			host.seedResponse("get_head_commit_message", {
				oid: "head-oid",
				subject: "feat: as committed",
				body: null,
			});
			await openRepository();
			const uncommittedChanges = (await screen.findByText("// WIP")).closest(
				'[data-testid="commit-row"]',
			) as HTMLElement;
			await fireEvent.click(await screen.findByRole("tab", { name: "Amend" }));
			await drainReplies();
			await fireEvent.input(draftSummary(), {
				target: { value: "feat: as amended" },
			});
			await selectCommit("first");
			await screen.findByText("first.txt");

			await fireEvent.click(uncommittedChanges);
			await drainReplies();

			expect(screen.getByRole("tab", { name: "Amend" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			expect(draftSummary().value).toBe("feat: as amended");
		});

		it("saves the draft typed just before the view closes", async () => {
			const view = await openRepository();
			await typeDraftSummary("feat: last words");

			view.unmount();
			await drainReplies();

			expect(await getCommitDraft("/repo")).toEqual({
				subject: "feat: last words",
				body: "",
			});
		});

		it("saves no draft cleared just before the view closes", async () => {
			const view = await openRepository();
			await typeDraftSummary("feat: changed my mind");
			await typeDraftSummary("");

			view.unmount();
			await drainReplies();

			expect(await getCommitDraft("/repo")).toBeNull();
		});

		it("reads the draft's summary as it is typed", async () => {
			await openRepository();

			await typeDraftSummary("feat: live label");

			expect(await wipMessage()).toHaveTextContent("feat: live label");
		});
	});

	describe("on Escape", () => {
		it("deselects the selected commit", async () => {
			await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");

			await fireEvent.keyDown(window, { key: "Escape" });
			await drainReplies();

			expect(screen.queryByTestId("commit-detail")).toBeNull();
			expect(commitRow("first")).toHaveAttribute("aria-selected", "false");
		});

		it("closes the commit's open file and keeps the commit selected", async () => {
			await openRepository();
			await selectCommit("first");
			await fireEvent.click(await screen.findByText("first.txt"));
			await screen.findByText("first file content");

			await fireEvent.keyDown(window, { key: "Escape" });
			await drainReplies();

			expect(screen.queryByText("first file content")).toBeNull();
			expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
		});

		it("leaves the selected commit to a text field that has focus", async () => {
			seedBranch();
			await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");
			await fireEvent.click(
				await screen.findByRole("button", { name: "Create new branch" }),
			);
			const branchName = await screen.findByPlaceholderText("New branch name");
			branchName.focus();

			await fireEvent.keyDown(branchName, { key: "Escape" });
			await drainReplies();

			expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
		});

		it("keeps a conflict resolution being typed in the merge editor", async () => {
			host.seedResponse("get_status", {
				unstaged: [],
				staged: [],
				conflicted: [
					{ path: "README.md", status: "Conflicted", is_binary: false },
				],
			});
			host.seedResponse("get_merge_sides", makeMergeSides());
			await openRepository();
			await fireEvent.click(await screen.findByText("README.md"));
			await vi.dynamicImportSettled();
			const output = await screen.findByRole("textbox", {
				name: "Merge output",
			});
			output.focus();
			await fireEvent.input(output, { target: { value: "resolved\n" } });

			await fireEvent.keyDown(output, { key: "Escape" });
			await drainReplies();

			expect(screen.getByRole("textbox", { name: "Merge output" })).toHaveValue(
				"resolved\n",
			);
		});
	});

	it("scrolls to a parent whose link is clicked again while it loads", async () => {
		const view = await openRepository();
		seedCommit("first");
		host.seedResponse("get_commit_detail", {
			...detailFor("first"),
			parent_oids: ["second"],
		});
		await clickCommit("first");
		const parentLink = await screen.findByTitle(/^Go to parent second/);
		const scrolls = recordGraphScrolls(view.container);
		const detail = host.holdNextReply("get_commit_detail");
		seedCommit("second");
		await fireEvent.click(parentLink);
		await detail.entered;

		await fireEvent.click(parentLink);
		detail.release(detailFor("second"));
		await drainReplies();

		expect(scrolls).not.toEqual([]);
		expect(commitRow("second")).toHaveAttribute("aria-selected", "true");
	});

	it("reads a pending commit once when its row is clicked again", async () => {
		await openRepository();
		const detail = host.holdNextReply("get_commit_detail");
		await selectCommit("second");
		await detail.entered;

		await clickCommit("second");
		detail.release(detailFor("second"));
		await drainReplies();

		expect(
			host.requests.filter((request) => request.cmd === "get_commit_detail"),
		).toHaveLength(1);
	});

	it("keeps the selected commit when its row is clicked again", async () => {
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");

		await clickCommit("first");
		await drainReplies();

		expect(screen.getByTestId("commit-detail")).toHaveTextContent(
			"first change",
		);
		expect(commitRow("first")).toHaveAttribute("aria-selected", "true");
	});

	it("opens a collapsed right pane when the selected commit is clicked again", async () => {
		const collapses: boolean[] = [];
		const view = await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await view.rerender({
			rightPaneCollapsed: true,
			onrightpanecollapsedchange: (collapsed: boolean) =>
				collapses.push(collapsed),
		});

		await clickCommit("first");
		await drainReplies();

		expect(collapses).toEqual([false]);
	});

	it("advances through commit diffs with j while metadata is pending", async () => {
		await openRepository();
		await selectCommit("first");
		await fireEvent.click(await screen.findByText("first.txt"));
		await screen.findByText("first file content");
		const second = host.holdNextReply("get_commit_detail");
		const third = host.holdNextReply("get_commit_detail");
		seedCommit("second");
		await fireEvent.keyDown(window, { key: "j" });
		await second.entered;

		seedCommit("third");
		await fireEvent.keyDown(window, { key: "j" });
		expect(await third.entered).toMatchObject({ oid: "third" });
		third.release(detailFor("third"));
		await screen.findByText("third file content");
		second.release(detailFor("second"));
		await drainReplies();

		expect(screen.getByText("third file content")).toBeVisible();
		expect(screen.queryByText("second file content")).toBeNull();
	});

	it("keeps the newest selection when an earlier statistic arrives last", async () => {
		const earlierStatistics = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await selectCommit("second");
		await within(await screen.findByTestId("commit-detail")).findByText("+23");

		earlierStatistics.release({
			files_changed: 1,
			insertions: 17,
			deletions: 2,
		});
		await drainReplies();

		const detail = screen.getByTestId("commit-detail");
		expect(detail).toHaveTextContent("second change");
		expect(within(detail).getByText("+23")).toBeVisible();
		expect(within(detail).queryByText("+17")).toBeNull();
	});

	it("keeps a deselected commit closed when its statistics arrive", async () => {
		const statistics = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");

		await fireEvent.click(
			screen.getByRole("button", { name: "Close commit detail" }),
		);
		statistics.release({ files_changed: 1, insertions: 17, deletions: 2 });
		await drainReplies();

		expect(screen.queryByTestId("commit-detail")).toBeNull();
		expect(screen.queryByText("first.txt")).toBeNull();
	});

	it("uses immutable statistics when their commit is selected again", async () => {
		const earlier = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await fireEvent.click(
			screen.getByRole("button", { name: "Close commit detail" }),
		);
		host.holdNextReply("commit_stat");
		await selectCommit("first");
		await screen.findByText("first.txt");

		earlier.release({ files_changed: 1, insertions: 17, deletions: 2 });
		await drainReplies();

		expect(
			within(screen.getByTestId("commit-detail")).getByText("+17"),
		).toBeVisible();
	});

	it("keeps valid statistics when an earlier read for the same commit fails", async () => {
		const earlier = host.holdNextReply("commit_stat");
		await openRepository();
		await selectCommit("first");
		await screen.findByText("first.txt");
		await fireEvent.click(
			screen.getByRole("button", { name: "Close commit detail" }),
		);
		await selectCommit("first");
		await within(await screen.findByTestId("commit-detail")).findByText("+17");

		earlier.reject({ code: "git_error", message: "statistics unavailable" });
		await drainReplies();

		expect(
			within(screen.getByTestId("commit-detail")).getByText("+17"),
		).toBeVisible();
	});

	describe("when a read fails", () => {
		it.each(["get_commit_detail", "list_commit_files"])(
			"reports a current $0 failure",
			async (command) => {
				await openRepository();
				const read = host.holdNextReply(command);
				await selectCommit("first");
				await read.entered;

				read.reject({ code: "git_error", message: "commit data unavailable" });
				await drainReplies();

				expect(toasts.items).toContainEqual(
					expect.objectContaining({
						kind: "error",
						message: "commit data unavailable",
					}),
				);
				expect(screen.queryByTestId("commit-detail")).toBeNull();
			},
		);

		it("ignores an obsolete metadata failure after a newer commit is usable", async () => {
			await openRepository();
			const read = host.holdNextReply("get_commit_detail");
			await selectCommit("first");
			await read.entered;
			await selectCommit("second");
			await screen.findByText("second.txt");

			read.reject({
				code: "git_error",
				message: "old commit data unavailable",
			});
			await drainReplies();

			expect(toasts.items).toEqual([]);
			expect(screen.getByTestId("commit-detail")).toHaveTextContent(
				"second change",
			);
		});

		it("retains usable files and details after statistics fail", async () => {
			const statistics = host.holdNextReply("commit_stat");
			await openRepository();
			await selectCommit("first");
			await screen.findByText("first.txt");

			statistics.reject({
				code: "git_error",
				message: "statistics unavailable",
			});
			await drainReplies();

			expect(screen.getByText("first.txt")).toBeVisible();
			expect(screen.getByTestId("commit-detail")).toHaveTextContent(
				"first change",
			);
			expect(toasts.items).toEqual([]);
		});

		it("does not resurrect failed details when statistics arrive later", async () => {
			const files = host.holdNextReply("list_commit_files");
			const statistics = host.holdNextReply("commit_stat");
			await openRepository();
			await selectCommit("first");
			await files.entered;
			await statistics.entered;

			files.reject({ code: "git_error", message: "file list unavailable" });
			await drainReplies();
			statistics.release({ files_changed: 1, insertions: 17, deletions: 2 });
			await drainReplies();

			expect(screen.queryByTestId("commit-detail")).toBeNull();
			expect(screen.queryByText("first.txt")).toBeNull();
		});
	});
});

async function openRepository(panes: { rightPaneCollapsed?: boolean } = {}) {
	const rightPaneChanges: boolean[] = [];
	host.seedGraph({
		commits: [
			makeCommit({ oid: "first", summary: "first change" }),
			makeCommit({ oid: "second", summary: "second change" }),
			makeCommit({ oid: "third", summary: "third change" }),
			makeCommit({ oid: "fourth", summary: "fourth change" }),
		],
		max_columns: 1,
		checked: true,
		revision: 1,
	});
	const view = render(RepoView, {
		props: {
			repoPath: "/repo",
			diffPreferences: DiffPreferences.defaults(),
			remoteState: createRemoteState(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: panes.rightPaneCollapsed ?? false,
			tabActive: true,
			windowFocused: false,
			reviewActive: false,
			contentMode: "hunk",
			oncontentmodechange: () => {},
			onreviewpanelshowingchange: () => {},
			onleftpanecollapsedchange: () => {},
			onrightpanecollapsedchange: (collapsed) => {
				rightPaneChanges.push(collapsed);
				void view.rerender({ rightPaneCollapsed: collapsed });
			},
			onleftpanewidthchange: () => {},
			onrightpanewidthchange: () => {},
			onleavereview: () => {},
		},
		context: new Map([[SCHEDULER, new FakeScheduler()]]),
	});

	await screen.findAllByTestId("commit-row");
	return { ...view, rightPaneChanges };
}

function seedBranch(): void {
	host.seedResponse("list_refs", {
		local: [
			{
				name: "topic",
				is_head: false,
				upstream: null,
				ahead: 0,
				behind: 0,
				last_commit_timestamp: 0,
				remote: null,
			},
		],
		remote: [],
		tags: [],
		stashes: [],
	});
	host.seedResponse("resolve_ref", "first");
}

async function startSearch(query: string): Promise<void> {
	await host.emit("search-toggle", null);
	const search = await screen.findByPlaceholderText("Search commits…");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await fireEvent.input(search, { target: { value: query } });
	await vi.advanceTimersByTimeAsync(200);
	vi.useRealTimers();
}

function recordGraphScrolls(container: HTMLElement): number[] {
	const viewport = container.querySelector<HTMLElement>(
		".virtual-list-viewport",
	);
	if (!viewport) throw new Error("commit graph viewport is not shown");

	const scrolls: number[] = [];
	viewport.scrollTo = (options?: ScrollToOptions | number) => {
		if (typeof options !== "number") scrolls.push(options?.top ?? 0);
	};

	return scrolls;
}

function detailFor(oid: string): CommitDetail {
	return {
		...makeCommit({ oid, summary: `${oid} change` }),
		message: `${oid} change`,
		committer_name: "Test",
		committer_email: "test@example.invalid",
		committer_timestamp: 0,
	};
}

async function selectCommit(oid: string): Promise<void> {
	seedCommit(oid);
	await clickCommit(oid);
}

function seedCommit(oid: string): void {
	const file: FileDiff = {
		path: `${oid}.txt`,
		old_path: null,
		status: "Modified",
		is_binary: false,
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
		hunks: [],
	};
	host.seedResponse("get_commit_detail", detailFor(oid));
	host.seedResponse("list_commit_files", [file]);
	host.seedResponse("diff_commit_file", [fileDiff(oid)]);
	host.seedResponse("commit_stat", {
		files_changed: 1,
		insertions: oid === "first" ? 17 : 23,
		deletions: 2,
	});
}

function fileDiff(oid: string): FileDiff {
	return {
		path: `${oid}.txt`,
		old_path: null,
		status: "Modified",
		is_binary: false,
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
		hunks: [
			{
				header: "@@ -0,0 +1,1 @@",
				old_start: 0,
				old_lines: 0,
				new_start: 1,
				new_lines: 1,
				lines: [
					{
						origin: "Add",
						content: `${oid} file content`,
						old_lineno: null,
						new_lineno: 1,
						spans: [],
					},
				],
			},
		],
	};
}

function seedComparison(files: FileDiff[] = []): void {
	host.seedResponse("list_compare_files", files);
	host.seedResponse("compare_stat", {
		files_changed: 0,
		insertions: 0,
		deletions: 0,
	});
}

function hunkless(name: string): FileDiff {
	return { ...fileDiff(name), hunks: [] };
}

function loadedFile(name: string, content: string): FileDiff {
	const file = fileDiff(name);
	file.hunks[0].lines[0].content = content;

	return file;
}

async function openComparisonFile(
	name: string,
	content: string,
): Promise<void> {
	host.seedResponse("diff_compare_file", [loadedFile(name, content)]);
	await fireEvent.click(screen.getByText(`${name}.txt`));
	await screen.findByText(content);
}

async function compareCommit(
	baseOid: string,
	targetOid: string,
	files: FileDiff[] = [],
): Promise<void> {
	seedComparison(files);
	const base = host.holdNextReply("get_commit_detail");
	const target = host.holdNextReply("get_commit_detail");
	await fireEvent.click(commitRow(targetOid), { metaKey: true });
	await base.entered;
	await target.entered;
	base.release(detailFor(baseOid));
	target.release(detailFor(targetOid));
	await within(await screen.findByTestId("compare-header")).findByText(
		`${targetOid} change`,
	);
}

async function clickCommit(oid: string): Promise<void> {
	await fireEvent.click(commitRow(oid));
}

function commitRow(oid: string): HTMLElement {
	const row = screen
		.getAllByTestId("commit-row")
		.find((candidate) => candidate.textContent?.includes(`${oid} change`));
	if (!row) throw new Error(`commit row ${oid} is not shown`);

	return row;
}

async function pressNavigationKey(key: string): Promise<void> {
	const graph = commitRow("first").closest('[role="listbox"]');
	if (!graph) throw new Error("commit graph is not shown");

	await fireEvent.keyDown(graph, { key });
}

function* ancestorsOf(node: HTMLElement): Generator<HTMLElement> {
	for (let at = node.parentElement; at; at = at.parentElement) yield at;
}

async function drainReplies(): Promise<void> {
	await setImmediate();
	await tick();
}
