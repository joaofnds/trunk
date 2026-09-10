import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../../tests/app/fakes/scheduler.js";
import {
	type HostChannel,
	TauriInternals,
} from "../../../tests/app/harness/internals.js";
import {
	restoreLayout,
	stubLayout,
} from "../../__tests__/helpers/layout-stub.js";
import { createReviewComposerSession } from "../../lib/review-editors.svelte.js";
import { SCHEDULER } from "../../lib/scheduler.js";
import type { Anchor, CommitDetail, FileDiff } from "../../lib/types.js";
import DiffPanel from "../DiffPanel.svelte";
import CommentComposer from "./CommentComposer.svelte";

async function flushTransport() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

const anchor: Anchor = {
	commit_oid: "commit-a",
	file_path: "a.ts",
	source: "Diff",
	side: "New",
	start_line: 1,
	end_line: 1,
};

class DraftHost implements HostChannel {
	draft: { text: string; anchor: Anchor } | null = null;
	readonly threads: Record<string, unknown>[] = [];
	private held = new Map<string, Promise<void>>();
	readonly entered = new Set<string>();

	hold(command: string): () => void {
		let release = () => {};
		this.held.set(
			command,
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return () => {
			this.held.delete(command);
			release();
		};
	}

	onEvent(): void {}

	async invoke<T>(
		command: string,
		args: Record<string, unknown> = {},
	): Promise<T> {
		this.entered.add(command);
		const snapshot = this.draft;
		const held = this.held.get(command);
		this.held.delete(command);
		await held;
		let result: unknown = null;
		switch (command) {
			case "prefs_get":
				break;
			case "get_draft":
				result = snapshot;
				break;
			case "save_draft":
				this.draft = { text: String(args.text), anchor: args.anchor as Anchor };
				break;
			case "delete_draft":
				this.draft = null;
				break;
			case "add_thread":
				this.threads.push(args);
				this.draft = null;
				break;
			default:
				throw new Error(`Unsupported command: ${command}`);
		}
		return result as T;
	}
}

describe("composer operation lifetime", () => {
	let host: DraftHost;
	let transport: TauriInternals;
	let scheduler: FakeScheduler;
	beforeEach(() => {
		stubLayout({ width: 900, height: 400 });
		host = new DraftHost();
		transport = new TauriInternals(host);
		transport.install();
		scheduler = new FakeScheduler();
	});
	afterEach(() => {
		cleanup();
		transport.uninstall();
		restoreLayout();
	});

	function props(session = createReviewComposerSession()) {
		return {
			captured: { anchor, cachedExcerpt: "+a" },
			commitOid: "commit-a",
			repoPath: "/repo",
			composerSession: session,
			onclose: () => session.close(),
		};
	}
	function mount(p = props()) {
		return render(CommentComposer, {
			props: p,
			context: new Map([[SCHEDULER, scheduler]]),
		});
	}

	it("keeps a newer empty edit when a disk read arrives", async () => {
		host.draft = { text: "old disk text", anchor };
		const release = host.hold("get_draft");
		mount();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "new text" },
		});
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "" },
		});

		release();
		await flushTransport();

		expect(screen.getByRole("textbox")).toHaveValue("");
	});

	it("does not seed an already restored editor again after remount", async () => {
		host.draft = { text: "old disk text", anchor };
		const p = props();
		const view = mount(p);
		await waitFor(() =>
			expect(screen.getByRole("textbox")).toHaveValue("old disk text"),
		);
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "" },
		});
		view.unmount();

		mount(p);
		await flushTransport();

		expect(screen.getByRole("textbox")).toHaveValue("");
	});

	it("keeps the new editor autosaving after an older restore finishes", async () => {
		const release = host.hold("get_draft");
		const view = mount();
		await waitFor(() => expect(host.entered.has("get_draft")).toBe(true));
		const replacement = props();
		await view.rerender(replacement);
		await flushTransport();

		release();
		await flushTransport();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "save replacement" },
		});
		scheduler.flush();

		await waitFor(() =>
			expect(host.draft).toEqual({ text: "save replacement", anchor }),
		);
	});

	it("finishes cancel against its original editor after navigation", async () => {
		const original = props();
		const view = mount(original);
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "discard me" },
		});
		const release = host.hold("delete_draft");
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(host.entered.has("delete_draft")).toBe(true));
		const replacement = props();
		replacement.composerSession.draft.text = "keep replacement";
		await view.rerender(replacement);

		release();
		await waitFor(() => expect(original.composerSession.draft.text).toBe(""));

		expect(screen.getByRole("textbox")).toHaveValue("keep replacement");
	});

	it("does not submit an old review after both review props change during autosave", async () => {
		const p = {
			...props(),
			originatingReviewId: "review-a",
			activeReviewId: "review-a",
		};
		const view = mount(p);
		await flushTransport();
		const release = host.hold("save_draft");
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "belongs to a" },
		});
		scheduler.flush();
		await waitFor(() => expect(host.entered.has("save_draft")).toBe(true));
		await fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		await view.rerender({
			...p,
			originatingReviewId: "review-b",
			activeReviewId: "review-b",
		});

		release();
		await waitFor(() => expect(p.composerSession.submitting).toBe(false));

		expect(host.threads).toEqual([]);
		expect(screen.getByRole("textbox")).toHaveValue("belongs to a");
	});
	it("submits to the captured commit when navigation occurs during autosave", async () => {
		const file: FileDiff = {
			path: "a.ts",
			old_path: null,
			status: "Added",
			is_binary: false,
			hunks: [
				{
					header: "@@ -0,0 +1 @@",
					old_start: 0,
					old_lines: 0,
					new_start: 1,
					new_lines: 1,
					lines: [
						{
							origin: "Add",
							content: "a",
							old_lineno: null,
							new_lineno: 1,
							spans: [],
						},
					],
				},
			],
		};
		const commit: CommitDetail = {
			oid: "commit-a",
			short_oid: "commit-a",
			summary: "A",
			body: null,
			author_name: "Test",
			author_email: "test@example.com",
			author_timestamp: 0,
			committer_name: "Test",
			committer_email: "test@example.com",
			committer_timestamp: 0,
			parent_oids: [],
		};
		const session = createReviewComposerSession();
		const p = {
			fileDiffs: [file],
			commitDetail: commit,
			selectedPath: "a.ts",
			diffKind: "commit" as const,
			repoPath: "/repo",
			composerSession: session,
			onclose: () => {},
		};
		const view = render(DiffPanel, {
			props: p,
			context: new Map([[SCHEDULER, scheduler]]),
		});
		await fireEvent.click(
			await screen.findByRole("button", { name: "Comment File" }),
		);
		await flushTransport();
		const release = host.hold("save_draft");
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "belongs to commit a" },
		});
		scheduler.flush();
		await waitFor(() => expect(host.entered.has("save_draft")).toBe(true));
		await fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		await view.rerender({ ...p, commitDetail: { ...commit, oid: "commit-b" } });

		release();
		await waitFor(() => expect(host.threads).toHaveLength(1));

		expect(host.threads[0]).toMatchObject({
			text: "belongs to commit a",
			anchor: {
				commit_oid: "commit-a",
				file_path: "a.ts",
				source: "FullFile",
				start_line: 1,
				end_line: 1,
			},
		});
	});
});
