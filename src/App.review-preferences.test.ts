import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { aReply, aThread } from "./__tests__/helpers/thread-fixture.js";
import App from "./App.svelte";
import type {
	Review,
	ReviewFilter,
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
const REVIEW_FILTER = "Review filter selection";

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
	private readonly eventHandlers: EventHandler[] = [];
	private readonly reviews = new Map<string, RepositoryReviews>();
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

	seedReview(path: string, review: RepositoryReview): void {
		this.seedReviews(path, [review], review.review.id);
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
		const activeReview = repositoryReviews?.reviews.find(
			({ review }) => review.id === repositoryReviews.activeReviewId,
		);
		switch (cmd) {
			case "prefs_get": {
				const key = String(args.key);
				this.readPreferences.push(key);
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
				this.preferences.set(String(args.key), args.value);
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
			case "validate_recent_path":
				return true;
			case "get_commit_graph":
				return { commits: [], max_columns: 0 };
			case "list_refs":
				return { local: [], remote: [], tags: [], stashes: [] };
			case "get_operation_state":
				return {
					op_type: "None",
					source_branch: null,
					target_branch: null,
					progress: null,
					source_color_index: null,
					target_color_index: null,
					rebase_message: null,
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
});

describe("App review preference", () => {
	it("applies one selected filter across repository tabs and restores it after remount", async () => {
		seedTwoTabs();
		host.seedReview(REPO_A, reviewWith("open"));
		host.seedReview(REPO_B, reviewWith("done"));
		const firstMount = render(App);
		await selectedFilter("all");
		await reviewBadge(1);

		await chooseFilter("done");
		await reviewBadge(null);
		await activateTab("tab-b");

		await selectedFilter("done");
		await reviewBadge(1);
		firstMount.unmount();

		render(App);

		await selectedFilter("done");
		await reviewBadge(1);
		expect(host.preference("review_filter")).toBe("done");
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
	])(
		"uses all for $name without converting legacy data",
		async ({ stored }) => {
			seedOneTab();
			if (stored !== undefined) host.seedPreference("review_filter", stored);
			host.seedPreference("show_inline_comments", false);

			render(App);

			await selectedFilter("all");
			expect(host.preference("review_filter")).toBe(stored);
			expect(host.preference("show_inline_comments")).toBe(false);
			expect(host.preferenceReads()).not.toContain("show_inline_comments");
		},
	);

	it("keeps a user selection when the captured initial read resolves later", async () => {
		seedOneTab();
		host.seedPreference("review_filter", "open");
		const read = host.holdPreferenceRead("review_filter");
		render(App);
		await read.entered;
		await selectedFilter("all");

		await chooseFilter("done");
		await waitFor(() => expect(host.preference("review_filter")).toBe("done"));
		read.release();
		await nextTask();
		await tick();

		expect(screen.getByRole("combobox", { name: REVIEW_FILTER })).toHaveValue(
			"done",
		);
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
				name: `Activate review ${empty.review.id}`,
			}),
		);
		await reviewBadge(null);
		await fireEvent.click(
			await screen.findByRole("button", {
				name: `Activate review ${populated.review.id}`,
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
			state: "composing",
			published: false,
			thread_count: storedThreads.length,
			created_at: 0,
		},
		threads: storedThreads.map((thread) => ({ ...thread, review_id: id })),
		commits: [
			{
				oid: "commit-1",
				short_oid: "commit-1",
				summary: "First commit",
				is_snapshot: false,
			},
		],
	};
}

async function selectedFilter(expected: ReviewFilter): Promise<void> {
	await waitFor(() =>
		expect(screen.getByRole("combobox", { name: REVIEW_FILTER })).toHaveValue(
			expected,
		),
	);
}

async function chooseFilter(filter: ReviewFilter): Promise<void> {
	const selection = await screen.findByRole("combobox", {
		name: REVIEW_FILTER,
	});

	await fireEvent.change(selection, { target: { value: filter } });
	await selectedFilter(filter);
}

async function activateTab(tabId: string): Promise<void> {
	const tab = await waitFor(() => {
		const found = document.querySelector(`[data-tab-id="${tabId}"]`);
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
		const badge = screen
			.getByRole("button", { name: "Review" })
			.querySelector<HTMLElement>(".toolbar-badge");
		expect(badge ? Number(badge.textContent) : null).toBe(expected);
	});
}

async function openReviewPanel(): Promise<void> {
	await fireEvent.click(await screen.findByRole("button", { name: "Review" }));
	await screen.findByText("First commit");
}

function noteComposer(): HTMLTextAreaElement {
	const addNote = screen.getByRole("button", { name: "Add note" });
	const group = addNote.closest("li");
	const textarea = group?.querySelector<HTMLTextAreaElement>("textarea");
	if (!textarea) throw new Error("the review note composer is not open");

	return textarea;
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
