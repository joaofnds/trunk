import { setImmediate } from "node:timers/promises";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import RepoView from "../__tests__/helpers/update-repo-view-harness.svelte";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type { Anchor, Draft, FileDiff } from "../lib/types.js";
import {
	setUpdateFrozen,
	UpdatePreparation,
} from "../lib/updates-lifecycle.js";

class UpdateRepositoryHost extends RepositoryReadHost {
	draft: Draft | null = null;
	failSave = false;
	failPreference: string | null = null;
	private heldPreference: {
		key: string;
		entered(): void;
		wait: Promise<void>;
	} | null = null;
	holdPreference(key: string) {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.heldPreference = { key, entered: enter, wait };
		return { entered, release };
	}
	override async invoke<T>(
		command: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		const input = args as Record<string, unknown>;
		if (command === "prefs_get" && input.key === this.failPreference)
			throw new Error("preference unavailable");
		if (
			command === "prefs_get" &&
			this.heldPreference &&
			input.key === this.heldPreference.key
		) {
			const held = this.heldPreference;
			this.heldPreference = null;
			held.entered();
			await held.wait;
		}
		if (command === "save_draft") {
			if (this.failSave) throw new Error("draft disk unavailable");
			this.draft = {
				text: String(input.text),
				anchor: input.anchor as Anchor,
				whole_file: input.wholeFile === true,
			};
			this.requests.push({ cmd: command, args: input });
			onReply?.(null as T);
			return null as T;
		}
		if (command === "get_draft") {
			onReply?.(this.draft as T);
			return this.draft as T;
		}
		return super.invoke<T>(command, args, onReply);
	}
}

class UpdateRepositoryHarness {
	readonly host = new UpdateRepositoryHost();
	readonly clock = new FakeScheduler();
	readonly installed: string[] = [];
	readonly aborted: string[] = [];
	readonly recovered: Array<string | null> = [];
	recovery: Promise<string | null> = Promise.resolve(null);
	readonly preparation = new UpdatePreparation({
		prepare: async () => "restart-permit",
		drained: async () => {},
		install: async (version) => {
			this.installed.push(version);
		},
		abort: async (token) => {
			this.aborted.push(token);
		},
		freeze: setUpdateFrozen,
		settle: async () => {
			await tick();
		},
		waiting: () => {},
	});
	mount() {
		let recovered!: (error: string | null) => void;
		this.recovery = new Promise((resolve) => {
			recovered = resolve;
		});
		return render(RepoView, {
			props: {
				preparation: this.preparation,
				repoPath: "/repo",
				remoteState: createRemoteState(),
				leftPaneWidth: 200,
				leftPaneCollapsed: false,
				rightPaneWidth: 300,
				rightPaneCollapsed: false,
				tabActive: true,
				windowFocused: false,
				reviewActive: false,
				onreviewpanelshowingchange: () => {},
				onleftpanecollapsedchange: () => {},
				onrightpanecollapsedchange: () => {},
				onleftpanewidthchange: () => {},
				onrightpanewidthchange: () => {},
				onleavereview: () => {},
				onrecoveryready: (error: string | null) => {
					this.recovered.push(error);
					recovered(error);
				},
			},
			context: new Map([[SCHEDULER, this.clock]]),
		});
	}
	async open() {
		this.host.install();
		const file: FileDiff = {
			path: "draft.txt",
			old_path: null,
			status: "Modified",
			is_binary: false,
			old_size: null,
			new_size: null,
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
							content: "review this line",
							old_lineno: null,
							new_lineno: 1,
							spans: [],
						},
					],
				},
			],
		};
		this.host.seedResponse("get_status", {
			unstaged: [{ path: "draft.txt", status: "Modified", is_binary: false }],
			staged: [],
			conflicted: [],
		});
		this.host.seedResponse("diff_unstaged", [file]);
		const view = this.mount();
		await screen.findByTestId("commit-form-subject");
		await setImmediate();
		await tick();
		return view;
	}
	async writeDrafts() {
		await fireEvent.input(screen.getByTestId("commit-form-subject"), {
			target: { value: "latest commit summary" },
		});
		await fireEvent.input(
			screen.getByPlaceholderText("Description (optional)"),
			{ target: { value: "latest commit body" } },
		);
		await fireEvent.click(await screen.findByText("draft.txt"));
		await screen.findByText("review this line");
		await fireEvent.click(screen.getByText("Comment File"));
		const composer = await screen.findByPlaceholderText(
			"Leave a comment… Markdown supported",
		);
		await setImmediate();
		await tick();
		await fireEvent.input(composer, {
			target: { value: "latest review comment" },
		});
	}
	dispose() {
		cleanup();
		setUpdateFrozen(false);
		this.host.dispose();
	}
}

let harness: UpdateRepositoryHarness;
beforeEach(() => {
	installDomPolyfills({ viewportHeight: 300 });
	harness = new UpdateRepositoryHarness();
});
afterEach(() => {
	harness.dispose();
	restoreDomPolyfills();
});

describe("RepoView update preparation", () => {
	it("flushes the latest commit and comment and restores their context after remount", async () => {
		const view = await harness.open();
		await harness.writeDrafts();

		await harness.preparation.install("2.0.0");

		expect(harness.installed).toEqual(["2.0.0"]);
		expect(harness.host.draft?.text).toBe("latest review comment");
		expect(harness.host.preferences.get("commit_drafts")).toEqual({
			"/repo": { subject: "latest commit summary", body: "latest commit body" },
		});
		view.unmount();
		setUpdateFrozen(false);
		harness.mount();

		expect(
			await screen.findByPlaceholderText("Leave a comment… Markdown supported"),
		).toHaveValue("latest review comment");
		expect(await screen.findByText("review this line")).toBeVisible();
		await fireEvent.click(screen.getByLabelText("Close diff"));
		expect(await screen.findByTestId("commit-form-subject")).toHaveValue(
			"latest commit summary",
		);
		expect(screen.getByPlaceholderText("Description (optional)")).toHaveValue(
			"latest commit body",
		);
	});
	it("aborts without installing when the acknowledged comment save fails", async () => {
		await harness.open();
		await harness.writeDrafts();
		harness.host.failSave = true;

		await expect(harness.preparation.install("2.0.0")).rejects.toThrow();

		expect(harness.installed).toEqual([]);
		expect(harness.aborted).toEqual(["restart-permit"]);
		expect(
			screen.getByPlaceholderText("Leave a comment… Markdown supported"),
		).toHaveValue("latest review comment");
	});
	it("reports startup recovery only after supported drafts finish loading", async () => {
		harness.host.install();
		const pending = harness.host.holdPreference("commit_drafts");
		harness.mount();
		await pending.entered;
		await setImmediate();
		await tick();
		expect(harness.recovered).toEqual([]);

		pending.release();
		await screen.findByTestId("commit-form-subject");
		await setImmediate();
		await tick();

		expect(await harness.recovery).toBeNull();
		expect(harness.recovered).toEqual([null]);
	});
	it.each(["commit_drafts", "update_review_composer:/repo"])(
		"reports a failed %s restoration instead of startup readiness",
		async (key) => {
			harness.host.install();
			harness.host.failPreference = key;
			harness.mount();

			const error = await harness.recovery;

			expect(error).toEqual(expect.any(String));
			await expect(harness.preparation.install("2.0.0")).rejects.toThrow();
			expect(harness.installed).toEqual([]);
		},
	);
});
