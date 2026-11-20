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
import { FakeClipboard } from "../tests/app/fakes/clipboard.js";
import { FakeDialog } from "../tests/app/fakes/dialog.js";
import { FakeMenu } from "../tests/app/fakes/menu.js";
import { FakeOpener } from "../tests/app/fakes/opener.js";
import { FakePath } from "../tests/app/fakes/path.js";
import { FakeWebview } from "../tests/app/fakes/webview.js";
import { FakeWindow } from "../tests/app/fakes/window.js";
import type { EventHandler } from "../tests/app/harness/host-client.js";
import type {
	HostChannel,
	TauriInternals,
} from "../tests/app/harness/internals.js";
import { TauriInternals as AppInternals } from "../tests/app/harness/internals.js";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { restoreLayout, stubLayout } from "./__tests__/helpers/layout-stub.js";
import { aSessionCommit } from "./__tests__/helpers/session-commit-fixture.js";
import { aReply, aThread } from "./__tests__/helpers/thread-fixture.js";
import App from "./App.svelte";
import type {
	CommitDetail,
	DiffRequestOptions,
	FileDiff,
	Review,
	SessionCommit,
	Thread,
} from "./lib/types.js";

if (typeof globalThis.OffscreenCanvas === "undefined") {
	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return { font: "", measureText: () => ({ width: 50 }) };
		}
	} as unknown as typeof OffscreenCanvas;
}

if (typeof Element.prototype.scrollTo === "undefined") {
	Element.prototype.scrollTo = () => {};
}

if (typeof Element.prototype.scrollIntoView === "undefined") {
	Element.prototype.scrollIntoView = () => {};
}

const REPO_A = "/repo/A";
const REPO_B = "/repo/B";

interface RepositoryReview {
	review: Review;
	threads: Thread[];
	commits: SessionCommit[];
}

interface RepositoryReviews {
	activeReviewId: string;
	reviews: RepositoryReview[];
}

interface PreferenceReadBarrier {
	entered: Promise<void>;
	release(): void;
}

class StatefulAppHost implements HostChannel {
	private readonly preferences = new Map<string, unknown>();
	private readonly readPreferences: string[] = [];
	private readonly writtenPreferences: [string, unknown][] = [];
	private readonly eventHandlers: EventHandler[] = [];
	private readonly reviews = new Map<string, RepositoryReviews>();
	private readonly commitDiffs = new Map<
		string,
		{ oid: string; filePath: string }
	>();
	readonly diffRequests: { path: string; options: DiffRequestOptions }[] = [];
	private heldDiffMode: boolean | null = null;
	private readonly rejectedPreferenceReads = new Set<string>();
	private readonly rejectedPreferenceWrites = new Set<string>();
	private readonly heldReads = new Map<
		string,
		{
			entered: () => void;
			released: Promise<void>;
			release: () => void;
		}
	>();
	private nextListenerId = 1;

	seedPreference(key: string, value: unknown): void {
		this.preferences.set(key, value);
	}

	preference(key: string): unknown {
		return this.preferences.get(key);
	}

	preferenceReads(): readonly string[] {
		return this.readPreferences;
	}

	/** Every preference write the app made, in order, as key and value. */
	preferenceWrites(): readonly (readonly [string, unknown])[] {
		return this.writtenPreferences;
	}

	seedReview(path: string, review: RepositoryReview): void {
		this.seedReviews(path, [review], review.review.id);
	}

	seedCommitDiff(path: string, oid: string, filePath: string): void {
		this.commitDiffs.set(path, { oid, filePath });
	}

	holdDiffMode(showFullFile: boolean): void {
		this.heldDiffMode = showFullFile;
	}

	releaseDiffMode(): void {
		this.heldDiffMode = null;
	}

	rejectPreferenceRead(key: string): void {
		this.rejectedPreferenceReads.add(key);
	}

	rejectPreferenceWrite(key: string): void {
		this.rejectedPreferenceWrites.add(key);
	}

	seedReviews(
		path: string,
		reviews: RepositoryReview[],
		activeReviewId: string,
	): void {
		this.reviews.set(path, { activeReviewId, reviews });
	}

	holdPreferenceRead(key: string): PreferenceReadBarrier {
		let markEntered!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});

		this.heldReads.set(key, { entered: markEntered, released, release });

		return { entered, release };
	}

	async invoke<T>(
		cmd: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		const input = args as Record<string, unknown>;
		const answer = await this.answer(cmd, input);
		onReply?.(answer as T);

		return answer as T;
	}

	onEvent(handler: EventHandler): void {
		this.eventHandlers.push(handler);
	}

	private async answer(
		cmd: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		if (cmd === "plugin:event|listen") return this.nextListenerId++;
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "plugin:event|emit") {
			for (const handler of this.eventHandlers) {
				handler(String(args.event), args.payload);
			}

			return null;
		}

		const path = String(args.path ?? "");
		const repositoryReviews = this.reviews.get(path);
		const commitDiff = this.commitDiffs.get(path);
		const activeReview = repositoryReviews?.reviews.find(
			({ review }) => review.id === repositoryReviews.activeReviewId,
		);
		switch (cmd) {
			case "prefs_get": {
				const key = String(args.key);
				this.readPreferences.push(key);
				if (this.rejectedPreferenceReads.has(key)) {
					throw new Error(`could not read ${key}`);
				}
				const captured = this.preferences.has(key)
					? this.preferences.get(key)
					: null;
				const held = this.heldReads.get(key);
				if (held) {
					held.entered();
					await held.released;
					this.heldReads.delete(key);
				}

				return captured;
			}
			case "prefs_set":
				if (this.rejectedPreferenceWrites.has(String(args.key))) {
					throw new Error(`could not write ${String(args.key)}`);
				}
				this.preferences.set(String(args.key), args.value);
				this.writtenPreferences.push([String(args.key), args.value]);
				return null;
			case "canonical_repo_path":
				return path;
			case "list_reviews":
				return repositoryReviews?.reviews.map(({ review }) => review) ?? [];
			case "get_active_review":
				return repositoryReviews?.activeReviewId ?? null;
			case "get_review_snapshots":
				return { working_tree_snapshot: null, index_snapshot: null };
			case "list_threads":
				return activeReview?.threads ?? [];
			case "list_session_commits":
				return activeReview?.commits ?? [];
			case "set_active_review":
				if (repositoryReviews) {
					repositoryReviews.activeReviewId = String(args.reviewId);
					for (const handler of this.eventHandlers) {
						handler("reviews-changed", path);
					}
				}

				return null;
			case "resolve_threads":
				return [];
			case "get_commit_graph":
				return {
					commits: commitDiff
						? [makeCommit({ oid: commitDiff.oid, summary: `${path} commit` })]
						: [],
					max_columns: commitDiff ? 1 : 0,
					checked: true,
					revision: 1,
				};
			case "get_commit_detail":
				return commitDiff ? commitDetail(commitDiff.oid) : null;
			case "list_commit_files":
				return commitDiff ? [fileDiff(commitDiff.filePath)] : [];
			case "diff_commit_file": {
				const options = args.options as DiffRequestOptions;
				this.diffRequests.push({ path, options });
				if (this.heldDiffMode === options.showFullFile)
					return new Promise(() => {});

				return [
					fileDiff(
						String(args.filePath),
						`${options.showFullFile ? "FULL" : "HUNK"} ${path}`,
					),
				];
			}
			case "list_refs":
				return { local: [], remote: [], tags: [], stashes: [] };
			case "get_operation_state":
				return {
					op_type: "None",
					source_branch: null,
					target_branch: null,
					onto_oid: null,
					progress: null,
					rebase_message: null,
					commit: null,
				};
			case "get_push_target":
				return { remote: "origin", branch: "main" };
			case "get_status":
				return { unstaged: [], staged: [], conflicted: [] };
			case "get_dirty_counts":
				return {
					staged: 0,
					unstaged: 0,
					conflicted: 0,
					modified: 0,
					new: 0,
					deleted: 0,
					renamed: 0,
					typechange: 0,
				};
			case "check_undo_available":
				return false;
			case "list_stashes":
				return [];
			default:
				return null;
		}
	}
}

let host: StatefulAppHost;
let internals: TauriInternals;

beforeEach(() => {
	stubLayout({ width: 900, height: 400 });
	host = new StatefulAppHost();
	internals = new AppInternals(host);
	internals.route([
		new FakeWindow(),
		new FakeWebview(),
		new FakePath("/Users/test"),
		new FakeMenu(internals),
		new FakeDialog(),
		new FakeClipboard(),
		new FakeOpener(),
	]);
	internals.install();
});

afterEach(async () => {
	cleanup();
	await Promise.resolve();
	internals.uninstall();
	restoreLayout();
});

describe("App review preference", () => {
	it("narrows every repository tab to the preset the panel picks", async () => {
		seedTwoTabs();
		host.seedReview(REPO_A, reviewWith("open"));
		host.seedReview(REPO_B, reviewWith("done"));
		host.seedCommitDiff(REPO_B, "commit-b", "b.ts");
		render(App);
		await reviewBadge(1);
		await activateTab("tab-b");
		await screen.findByText(`${REPO_B} commit`);
		await reviewBadge(null);
		await activateTab("tab-a");
		await reviewBadge(1);
		await openReviewPanel();

		await fireEvent.click(await preset("Settled"));
		await reviewBadge(null);
		await activateTab("tab-b");

		await reviewBadge(1);
	});

	it("opens on every thread after a remount, keeping no preset", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		const firstMount = render(App);
		await openReviewPanel();
		await fireEvent.click(await preset("Settled"));
		await reviewBadge(null);
		firstMount.unmount();

		render(App);

		await reviewBadge(1);
		expect(host.preference("review_filter")).toBeUndefined();
	});

	it("keeps review threads hidden across a remount", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		const firstMount = render(App);
		await reviewBadge(1);
		await hideReviewThreads();
		firstMount.unmount();

		render(App);

		await screen.findByRole("button", { name: "Show review threads" });
		expect(host.preference("review_filter")).toBe("none");
	});

	it("hides review threads and reports a persistence failure", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		host.rejectPreferenceWrite("review_filter");
		render(App);
		await reviewBadge(1);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Hide review threads" }),
		);

		expect(
			await screen.findByRole("button", { name: "Show review threads" }),
		).toBeTruthy();
		expect(
			await screen.findByText("Could not save hidden review threads"),
		).toBeTruthy();
	});

	it("shows review threads and reports a preference read failure", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		host.rejectPreferenceRead("review_filter");

		render(App);

		expect(
			await screen.findByRole("button", { name: "Hide review threads" }),
		).toBeTruthy();
		expect(
			await screen.findByText("Could not load hidden review threads"),
		).toBeTruthy();
	});

	it("shows the review panel's threads while review threads are hidden", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await reviewBadge(1);
		await hideReviewThreads();

		await openReviewPanel();

		expect(await screen.findByText("open thread")).toBeVisible();
	});

	it("keeps the Review button's count while review threads are hidden", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await reviewBadge(1);

		await hideReviewThreads();
		await tick();

		await reviewBadge(1);
	});

	it("keeps review threads hidden when the panel picks a preset", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await reviewBadge(1);
		await hideReviewThreads();
		await openReviewPanel();

		await fireEvent.click(await preset("Settled"));

		expect(await preset("Settled")).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.getByRole("button", { name: "Show review threads" }),
		).toBeInTheDocument();
	});

	it("offers Comment on a file while review threads are hidden", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await reviewBadge(1);

		await hideReviewThreads();
		await openReviewPanel();

		expect(
			screen.getByRole("button", { name: "Comment on a file…" }),
		).toBeInTheDocument();
	});

	it.each([
		{
			name: "an absent preference",
			stored: undefined,
		},
		{
			name: "an invalid preference",
			stored: "legacy-toggle",
		},
		{
			name: "a single-state filter from before the presets",
			stored: "done",
		},
	])(
		"shows every thread for $name without converting legacy data",
		async ({ stored }) => {
			seedOneTab();
			if (stored !== undefined) host.seedPreference("review_filter", stored);
			host.seedPreference("show_inline_comments", false);

			render(App);
			await waitFor(() =>
				expect(host.preferenceReads()).toContain("review_filter"),
			);
			await nextTask();
			await tick();

			expect(
				screen.getByRole("button", { name: "Hide review threads" }),
			).toBeInTheDocument();
			expect(host.preference("review_filter")).toBe(stored);
			expect(host.preference("show_inline_comments")).toBe(false);
			expect(host.preferenceReads()).not.toContain("show_inline_comments");
		},
	);

	it("withholds Comment File from a graph diff while review threads are hidden", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		render(App);
		await hideReviewThreads();

		await fireEvent.click(await screen.findByTestId("commit-row"));
		await fireEvent.click(await screen.findByText("a.ts"));
		await screen.findByText(`HUNK ${REPO_A}`);

		expect(screen.queryByRole("button", { name: "Comment File" })).toBeNull();
	});

	it("offers Comment File in a graph diff while review threads show", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		render(App);

		await fireEvent.click(await screen.findByTestId("commit-row"));
		await fireEvent.click(await screen.findByText("a.ts"));
		await screen.findByText(`HUNK ${REPO_A}`);

		expect(
			screen.getByRole("button", { name: "Comment File" }),
		).toBeInTheDocument();
	});

	it("keeps a user's choice when the captured initial read resolves later", async () => {
		seedOneTab();
		host.seedPreference("review_filter", "none");
		const read = host.holdPreferenceRead("review_filter");
		render(App);
		await read.entered;

		await fireEvent.click(
			await screen.findByRole("button", { name: "Hide review threads" }),
		);
		await fireEvent.click(
			await screen.findByRole("button", { name: "Show review threads" }),
		);
		await waitFor(() => expect(host.preference("review_filter")).toBe("all"));
		read.release();
		await nextTask();
		await tick();

		expect(
			screen.getByRole("button", { name: "Hide review threads" }),
		).toBeInTheDocument();
	});

	it("shows counts only from the selected review when switching away and back", async () => {
		seedOneTab();
		const populated = reviewWith("open");
		const empty = reviewWith("done", []);
		host.seedReviews(REPO_A, [populated, empty], populated.review.id);
		render(App);
		await reviewBadge(1);
		await openReviewPanel();

		await fireEvent.click(
			await screen.findByRole("button", {
				name: `Active review ${empty.review.id}`,
			}),
		);
		await reviewBadge(null);
		await fireEvent.click(
			await screen.findByRole("button", {
				name: `Active review ${populated.review.id}`,
			}),
		);

		await reviewBadge(1);
	});

	it("drops unsaved note and reply text when their repository tab closes", async () => {
		seedOneTab();
		host.seedReview(
			REPO_A,
			reviewWith("open", [
				aThread({
					id: "thread-with-reply",
					text: "existing thread",
					text_html: "existing thread",
					commit_oid: "commit-1",
					replies: [
						aReply({
							id: "reply-1",
							text: "existing reply",
							text_html: "existing reply",
						}),
					],
				}),
			]),
		);
		render(App);
		await openReviewPanel();
		const addNote = await screen.findByRole("button", { name: "Add note" });
		await fireEvent.click(addNote);
		const note = await waitFor(() => noteComposer());
		const reply = await screen.findByRole("textbox", { name: "Reply" });
		await fireEvent.input(note, { target: { value: "unsaved note" } });
		await fireEvent.input(reply, { target: { value: "unsaved reply" } });

		await fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
		const recent = await screen.findByRole("button", { name: /repo\/A/ });
		await fireEvent.click(recent);
		await screen.findByText("First commit");

		expect(screen.queryByDisplayValue("unsaved note")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("unsaved reply")).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
	});
});

describe("App diff content mode", () => {
	it("shows a non-interactive repository loading state until content mode is known", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		const read = host.holdPreferenceRead("diff_content_mode");
		render(App);
		await read.entered;

		expect(await screen.findByLabelText("Loading repository")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Open Repository" }),
		).toBeFalsy();

		read.release();
		expect(await screen.findByTestId("commit-row")).toBeTruthy();
	});

	it("uses the in-memory mode and reports a persistence failure", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		host.rejectPreferenceWrite("diff_content_mode");
		render(App);
		const row = await screen.findByTestId("commit-row");
		await fireEvent.click(row);
		await fireEvent.click(await screen.findByText("a.ts"));
		await screen.findByText(`HUNK ${REPO_A}`);

		await fireEvent.click(screen.getByTitle("Show full file"));

		expect(await screen.findByText(`FULL ${REPO_A}`)).toBeTruthy();
		expect(
			await screen.findByText("Could not save diff content mode"),
		).toBeTruthy();
	});

	it("falls back to hunk mode and reports a preference read failure", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		host.rejectPreferenceRead("diff_content_mode");
		render(App);
		const row = await screen.findByTestId("commit-row");
		await fireEvent.click(row);
		await fireEvent.click(await screen.findByText("a.ts"));

		expect(await screen.findByText(`HUNK ${REPO_A}`)).toBeTruthy();
		expect(
			await screen.findByText("Could not load diff content mode"),
		).toBeTruthy();
	});

	it("reloads already-open diffs in every mounted repository tab", async () => {
		seedTwoTabs();
		host.seedPreference("diff_content_mode", "full");
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		host.seedCommitDiff(REPO_B, "commit-b", "b.ts");
		host.holdDiffMode(false);
		render(App);
		const firstRow = await screen.findByTestId("commit-row");

		await fireEvent.click(firstRow);
		await fireEvent.click(await screen.findByText("a.ts"));
		await screen.findByText(`FULL ${REPO_A}`);
		await activateTab("tab-b");
		await fireEvent.click(await shownCommitRow());
		await fireEvent.click(await screen.findByText("b.ts"));
		await screen.findByText(`FULL ${REPO_B}`);

		await activateTab("tab-a");
		await fireEvent.click(screen.getAllByTitle("Show hunks")[0]);

		await waitFor(() => {
			const hunkRequests = host.diffRequests.filter(
				({ options }) => !options.showFullFile,
			);
			expect(hunkRequests.map(({ path }) => path)).toEqual([REPO_A, REPO_B]);
			expect(screen.queryByText(`FULL ${REPO_A}`)).not.toBeInTheDocument();
			expect(screen.queryByText(`FULL ${REPO_B}`)).not.toBeInTheDocument();
		});
		expect(host.preference("diff_content_mode")).toBe("hunk");

		host.releaseDiffMode();
		await fireEvent.click(screen.getAllByLabelText("Close diff")[0]);
		await fireEvent.click(await screen.findByText("a.ts"));

		expect(await screen.findByText(`HUNK ${REPO_A}`)).toBeTruthy();
		expect(host.diffRequests.at(-1)).toEqual({
			path: REPO_A,
			options: expect.objectContaining({ showFullFile: false }),
		});
	});

	it("reloads every mounted tab when switching from hunks to full files", async () => {
		seedTwoTabs();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		host.seedCommitDiff(REPO_B, "commit-b", "b.ts");
		host.holdDiffMode(true);
		render(App);
		const firstRow = await screen.findByTestId("commit-row");
		await fireEvent.click(firstRow);
		await fireEvent.click(await screen.findByText("a.ts"));
		await screen.findByText(`HUNK ${REPO_A}`);
		await activateTab("tab-b");
		await fireEvent.click(await shownCommitRow());
		await fireEvent.click(await screen.findByText("b.ts"));
		await screen.findByText(`HUNK ${REPO_B}`);

		await activateTab("tab-a");
		await fireEvent.click(screen.getAllByTitle("Show full file")[0]);

		await waitFor(() => {
			const fullRequests = host.diffRequests.filter(
				({ options }) => options.showFullFile,
			);
			expect(fullRequests.map(({ path }) => path)).toEqual([REPO_A, REPO_B]);
			expect(screen.queryByText(`HUNK ${REPO_A}`)).not.toBeInTheDocument();
			expect(screen.queryByText(`HUNK ${REPO_B}`)).not.toBeInTheDocument();
		});
	});
});

describe("App diff settings", () => {
	it("shows a non-interactive repository loading state until the diff settings are known", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		const read = host.holdPreferenceRead("diff_ignore_whitespace");
		render(App);
		await read.entered;
		await nextTask();

		expect(
			document.querySelector('[data-tab-id="tab-a"] [role="tab"]'),
		).toBeInstanceOf(HTMLElement);
		expect(screen.getByLabelText("Loading repository")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Open Repository" }),
		).toBeFalsy();

		read.release();
		expect(await screen.findByTestId("commit-row")).toBeTruthy();
	});

	it("opens the repository on the default settings and reports a settings read failure", async () => {
		seedOneTab();
		host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
		host.rejectPreferenceRead("diff_word_wrap");
		render(App);

		expect(await screen.findByTestId("commit-row")).toBeTruthy();
		expect(
			await screen.findByText("Could not load diff settings"),
		).toBeTruthy();
	});

	it("applies a setting changed in one tab to the open diff in every mounted tab", async () => {
		await openDiffsInTwoTabs();

		await fireEvent.click(screen.getAllByTitle("Ignore whitespace changes")[1]);

		await waitFor(() => {
			const ignoring = host.diffRequests.filter(
				({ options }) => options.ignoreWhitespace,
			);
			expect(ignoring.map(({ path }) => path).sort()).toEqual([REPO_A, REPO_B]);
		});
		expect(
			screen
				.getAllByTitle("Ignore whitespace changes")
				.map((toggle) => toggle.getAttribute("aria-pressed")),
		).toEqual(["true", "true"]);
	});

	it("saves a changed setting for the next launch", async () => {
		await openDiffsInTwoTabs();

		await fireEvent.click(screen.getAllByTitle("Ignore whitespace changes")[1]);

		await waitFor(() =>
			expect(host.preference("diff_ignore_whitespace")).toBe(true),
		);
	});

	it("keeps a setting it could not save and reports the failure", async () => {
		host.rejectPreferenceWrite("diff_ignore_whitespace");
		await openDiffsInTwoTabs();

		await fireEvent.click(screen.getAllByTitle("Ignore whitespace changes")[1]);

		expect(
			await screen.findByText("Could not save diff settings"),
		).toBeTruthy();
		expect(
			screen
				.getAllByTitle("Ignore whitespace changes")
				.map((toggle) => toggle.getAttribute("aria-pressed")),
		).toEqual(["true", "true"]);
	});
});

async function openDiffsInTwoTabs(): Promise<void> {
	seedTwoTabs();
	host.seedCommitDiff(REPO_A, "commit-a", "a.ts");
	host.seedCommitDiff(REPO_B, "commit-b", "b.ts");
	render(App);
	await fireEvent.click(await screen.findByTestId("commit-row"));
	await fireEvent.click(await screen.findByText("a.ts"));
	await screen.findByText(`HUNK ${REPO_A}`);
	await activateTab("tab-b");
	await fireEvent.click(await shownCommitRow());
	await fireEvent.click(await screen.findByText("b.ts"));
	await screen.findByText(`HUNK ${REPO_B}`);
}

describe("App side panes", () => {
	const panes = [
		{
			pane: "sidebar",
			shortcut: "j",
			narrow: "ArrowLeft",
			widen: "ArrowRight",
			floor: "80",
			widthKey: "left_pane_width",
		},
		{
			pane: "detail pane",
			shortcut: "k",
			narrow: "ArrowRight",
			widen: "ArrowLeft",
			floor: "200",
			widthKey: "right_pane_width",
		},
	];

	it.each(panes)(
		"keeps the focus on the $pane's divider when its shortcut collapses the pane",
		async ({ pane, shortcut }) => {
			seedOneTab();
			render(App);
			const divider = await screen.findByRole("slider", {
				name: `Resize ${pane}`,
			});
			await nextTask();
			divider.focus();

			await fireEvent.keyDown(divider, { key: shortcut, metaKey: true });

			expect(
				screen.getByRole("slider", { name: `Resize ${pane}` }),
			).toHaveFocus();
		},
	);

	it.each(panes)(
		"reopens the $pane at its floor after a step reopened it and a step closed it",
		async ({ pane, shortcut, narrow, widen, floor }) => {
			seedOneTab();
			render(App);
			const divider = await screen.findByRole("slider", {
				name: `Resize ${pane}`,
			});
			await nextTask();
			await fireEvent.keyDown(divider, { key: narrow });
			await pressShortcut(shortcut);
			await fireEvent.keyDown(divider, { key: widen });
			await fireEvent.keyDown(divider, { key: narrow });

			await pressShortcut(shortcut);

			expect(divider).toHaveAttribute("aria-valuenow", floor);
		},
	);

	it("writes the sidebar's width to the preferences once for a drag", async () => {
		seedOneTab();
		host.seedPreference("left_pane_width", 300);
		render(App);
		const divider = await screen.findByRole("slider", {
			name: "Resize sidebar",
		});
		await nextTask();

		await fireEvent.mouseDown(divider, { clientX: 1000 });
		await fireEvent.mouseMove(window, { clientX: 1010 });
		await fireEvent.mouseMove(window, { clientX: 1020 });
		await fireEvent.mouseMove(window, { clientX: 1030 });
		await fireEvent.mouseUp(window);

		expect(paneWrites()).toEqual([["left_pane_width", 330]]);
	});

	it.each(panes)(
		"writes the width a step leaves the $pane at",
		async ({ pane, narrow, widthKey }) => {
			seedOneTab();
			host.seedPreference(widthKey, 300);
			render(App);
			const divider = await screen.findByRole("slider", {
				name: `Resize ${pane}`,
			});
			await nextTask();

			await fireEvent.keyDown(divider, { key: narrow });

			expect(paneWrites()).toEqual([[widthKey, 292]]);
		},
	);

	it("keeps the graph's sidebar collapsed after the reviews are opened", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		host.seedPreference("left_pane_collapsed", true);
		host.seedPreference("review_left_pane_collapsed", true);
		render(App);
		await openReviewPanel();
		await pressShortcut("j");
		expect(
			await screen.findByRole("navigation", { name: "Reviews" }),
		).toBeVisible();

		await leaveReview();

		expect(
			screen.getByRole("slider", { name: "Resize sidebar" }),
		).toHaveAttribute("aria-valuenow", "0");
	});

	it("opens review mode on the reviews' own collapsed state", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		host.seedPreference("review_left_pane_collapsed", true);
		render(App);
		await screen.findByRole("slider", { name: "Resize sidebar" });

		await openReviewPanel();
		await tick();

		expect(screen.queryByRole("navigation", { name: "Reviews" })).toBeNull();
	});

	it("keeps the graph's sidebar preference when the reviews are dragged closed", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await openReviewPanel();

		const divider = await screen.findByRole("slider", {
			name: "Resize sidebar",
		});
		await fireEvent.mouseDown(divider, { clientX: 1000 });
		await fireEvent.mouseMove(window, { clientX: 700 });
		await fireEvent.mouseUp(window);

		expect(host.preference("review_left_pane_collapsed")).toBe(true);
		expect(host.preference("left_pane_collapsed")).toBeUndefined();
	});

	it("keeps the graph's detail pane open through the shortcut in review mode", async () => {
		seedOneTab();
		host.seedReview(REPO_A, reviewWith("open"));
		render(App);
		await openReviewPanel();

		await pressShortcut("k");
		await leaveReview();

		expect(
			screen.getByRole("slider", { name: "Resize detail pane" }),
		).not.toHaveAttribute("aria-valuenow", "0");
	});
});

/** The side panes' widths and collapsed states the app wrote, in order. */
function paneWrites(): (readonly [string, unknown])[] {
	return host.preferenceWrites().filter(([key]) => key.includes("_pane_"));
}

function seedOneTab(): void {
	host.seedPreference("open_tabs", [
		{ id: "tab-a", repoPath: REPO_A, repoName: "A" },
	]);
	host.seedPreference("active_tab_id", "tab-a");
	host.seedPreference("recent_repos", [{ name: "A", path: REPO_A }]);
}

function seedTwoTabs(): void {
	host.seedPreference("open_tabs", [
		{ id: "tab-a", repoPath: REPO_A, repoName: "A" },
		{ id: "tab-b", repoPath: REPO_B, repoName: "B" },
	]);
	host.seedPreference("active_tab_id", "tab-a");
}

function reviewWith(
	state: "open" | "done",
	threads?: Thread[],
): RepositoryReview {
	const id = state === "open" ? "review-open" : "review-done";
	const storedThreads = threads ?? [
		aThread({
			id: `thread-${state}`,
			review_id: id,
			text: `${state} thread`,
			text_html: `${state} thread`,
			commit_oid: "commit-1",
			state,
			allowed_transitions: state === "open" ? ["done", "dismissed"] : ["open"],
		}),
	];

	return {
		review: {
			id,
			title: `${state} review`,
			state: "settled",
			visible_to_agent: false,
			archived: false,
			thread_count: storedThreads.length,
			unresolved_count: storedThreads.filter((t) => t.state === "open").length,
			pending_count: 0,
			created_at: 0,
		},
		threads: storedThreads.map((thread) => ({ ...thread, review_id: id })),
		commits: [
			aSessionCommit({
				oid: "commit-1",
				short_oid: "commit-1",
				summary: "First commit",
			}),
		],
	};
}

function commitDetail(oid: string): CommitDetail {
	return {
		oid,
		short_oid: oid,
		summary: oid,
		body: null,
		author_name: "Test",
		author_email: "test@example.com",
		author_timestamp: 0,
		committer_name: "Test",
		committer_email: "test@example.com",
		committer_timestamp: 0,
		parent_oids: [],
	};
}

function fileDiff(path: string, content?: string): FileDiff {
	return {
		path,
		old_path: null,
		status: "Modified",
		is_binary: false,
		hunks: content
			? [
					{
						header: "@@ -1,0 +1,1 @@",
						old_start: 1,
						old_lines: 0,
						new_start: 1,
						new_lines: 1,
						lines: [
							{
								origin: "Add",
								content,
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				]
			: [],
	};
}

async function preset(label: string): Promise<HTMLElement> {
	const panel = await screen.findByLabelText("Review threads", {
		selector: "section",
	});
	return within(panel).findByRole("button", { name: new RegExp(`^${label}`) });
}

// A graph stays mounted under a diff and under an inactive tab, so the row to
// click is the one in the graph on screen.
async function shownCommitRow(): Promise<HTMLElement> {
	return waitFor(() => {
		const row = screen
			.getAllByTestId("commit-row")
			.find((candidate) => candidate.closest(".invisible") === null);
		if (!row) throw new Error("no commit row is on screen");
		return row;
	});
}

async function activateTab(tabId: string): Promise<void> {
	const tab = await waitFor(() => {
		const found = document.querySelector(
			`[data-tab-id="${tabId}"] [role="tab"]`,
		);
		if (!(found instanceof HTMLElement)) {
			throw new Error(`the ${tabId} repository tab is not mounted`);
		}

		return found;
	});

	await fireEvent.mouseDown(tab, { button: 0 });
	await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
}

async function reviewBadge(expected: number | null): Promise<void> {
	await waitFor(() => {
		const review = screen.getByLabelText("Review", { selector: "button" });
		const badge = review.querySelector<HTMLElement>(".toolbar-badge");
		expect(badge ? Number(badge.textContent) : null).toBe(expected);
	});
}

async function hideReviewThreads(): Promise<void> {
	await fireEvent.click(
		await screen.findByRole("button", { name: "Hide review threads" }),
	);
	await waitFor(() => expect(host.preference("review_filter")).toBe("none"));
}

async function openReviewPanel(): Promise<void> {
	await fireEvent.click(
		await screen.findByLabelText("Review", { selector: "button" }),
	);
	await vi.dynamicImportSettled();
	await tick();
	await screen.findByText("First commit");
}

async function leaveReview(): Promise<void> {
	await fireEvent.click(
		screen.getByLabelText("Review", { selector: "button" }),
	);
	await waitFor(() =>
		expect(screen.getByTestId("branch-sidebar")).toBeVisible(),
	);
}

async function pressShortcut(key: string): Promise<void> {
	await fireEvent.keyDown(window, { key, metaKey: true });
}

function noteComposer(): HTMLElement {
	const composer = screen.getByRole("group", { name: /^Note on / });

	return within(composer).getByRole("textbox");
}

async function nextTask(): Promise<void> {
	await new Promise<void>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(null);
	});
}
