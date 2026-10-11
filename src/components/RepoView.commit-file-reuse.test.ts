import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { makeCommit } from "../__tests__/helpers/factories.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import {
	disablePerf,
	enablePerf,
	type PerfSample,
	type PerfSink,
} from "../lib/perf.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import type { CommitDetail, FileDiff } from "../lib/types.js";
import { createUndoRedoState } from "../lib/undo-redo.svelte.js";
import RepoView from "./RepoView.svelte";

let host: RepositoryReadHost;

function file(path: string, content?: string): FileDiff {
	return {
		path,
		old_path: null,
		status: "Modified",
		is_binary: false,
		hunks:
			content === undefined
				? []
				: [
						{
							header: "@@ -1 +1 @@",
							old_start: 1,
							old_lines: 1,
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
					],
	};
}

function detail(oid: string): CommitDetail {
	return {
		oid,
		short_oid: oid,
		summary: "first commit",
		body: null,
		author_name: "Test",
		author_email: "test@test.com",
		author_timestamp: 0,
		committer_name: "Test",
		committer_email: "test@test.com",
		committer_timestamp: 0,
		parent_oids: [],
	};
}

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	installDomPolyfills();
	host.seedGraph({
		commits: [makeCommit({ oid: "commit-1", summary: "first commit" })],
		max_columns: 1,
		revision: 1,
	});
	host.seedResponse("list_commit_files", [file("f.ts"), file("g.ts")]);
	host.seedResponse("get_commit_detail", detail("commit-1"));
});

afterEach(() => {
	cleanup();
	disablePerf();
	host.dispose();
	restoreDomPolyfills();
});

async function mountCommit() {
	const view = render(RepoView, {
		props: {
			repoPath: "/repo",
			repoName: "repo",
			remoteState: createRemoteState(),
			undoRedo: createUndoRedoState(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: false,
			tabActive: true,
			reviewActive: false,
			contentMode: "hunk",
			oncontentmodechange() {},
			onreviewpanelshowingchange() {},
			onleftpanecollapsedchange() {},
			onrightpanecollapsedchange() {},
			onleftpanewidthchange() {},
			onrightpanewidthchange() {},
			onleavereview() {},
		},
		context: new Map([[SCHEDULER, new FakeScheduler()]]),
	});
	await fireEvent.click((await screen.findAllByTestId("commit-row"))[0]);
	await screen.findByTestId("commit-detail");

	return view;
}

async function openFile(path: string, content: string) {
	host.seedResponse("diff_commit_file", [file(path, content)]);
	await fireEvent.click(
		within(screen.getByTestId("commit-detail")).getByText(path),
	);
	await screen.findByText(content);
}

async function selectFile(path: string) {
	await fireEvent.click(
		within(screen.getByTestId("commit-detail")).getByText(path),
	);
}

describe("RepoView commit file reuse", () => {
	it("returns to a loaded file without another backend read", async () => {
		await mountCommit();
		await openFile("f.ts", "FIRST");
		await openFile("g.ts", "SECOND");

		await openFile("f.ts", "FIRST");

		expect(screen.getByText("FIRST")).toBeTruthy();
		expect(host.count("diff_commit_file")).toBe(2);
	});

	it("preserves syntax highlighting and word emphasis when returning to a file", async () => {
		await mountCommit();
		const highlighted = file("f.ts", "TOKEN");
		highlighted.hunks[0].lines[0].spans = [
			{
				start: 0,
				end: 5,
				syntax_class: "syn-keyword",
				emphasized: true,
			},
		];
		host.seedResponse("diff_commit_file", [highlighted]);
		await selectFile("f.ts");
		expect(await screen.findByText("TOKEN")).toHaveClass(
			"syn-keyword",
			"word-add",
		);
		await openFile("g.ts", "SECOND");

		await selectFile("f.ts");

		expect(await screen.findByText("TOKEN")).toHaveClass(
			"syn-keyword",
			"word-add",
		);
		expect(host.count("diff_commit_file")).toBe(2);
	});

	it("reopens a closed file from its retained payload", async () => {
		await mountCommit();
		await openFile("f.ts", "FIRST");

		await fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
		await openFile("f.ts", "FIRST");

		expect(host.count("diff_commit_file")).toBe(1);
	});

	it("reuses a loaded binary file without requiring text hunks", async () => {
		await mountCommit();
		host.seedResponse("diff_commit_file", [
			{ ...file("f.ts"), is_binary: true },
		]);
		await selectFile("f.ts");
		await screen.findByText("Binary file — no diff available");
		await openFile("g.ts", "SECOND");

		await selectFile("f.ts");
		await screen.findByText("Binary file — no diff available");

		expect(host.count("diff_commit_file")).toBe(2);
	});

	it("reads a file again after selecting another commit", async () => {
		host.seedGraph({
			commits: [
				makeCommit({ oid: "commit-1" }),
				makeCommit({ oid: "commit-2" }),
			],
			max_columns: 1,
			revision: 1,
		});
		await mountCommit();
		await openFile("f.ts", "FIRST COMMIT");
		host.seedResponse("diff_commit_file", [file("f.ts", "SECOND COMMIT")]);

		host.seedResponse("get_commit_detail", detail("commit-2"));
		await fireEvent.click(
			screen.getByRole("button", { name: "Go to older commit" }),
		);
		await screen.findByText("SECOND COMMIT");

		expect(screen.queryByText("FIRST COMMIT")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(2);
	});

	it("loads a retained hunk file again for full-file mode", async () => {
		const view = await mountCommit();
		await openFile("f.ts", "FIRST HUNK");
		await openFile("g.ts", "SECOND HUNK");
		host.seedResponse("diff_commit_file", [file("g.ts", "SECOND FULL")]);
		await view.rerender({ contentMode: "full" });
		await screen.findByText("SECOND FULL");

		await openFile("f.ts", "FIRST FULL");

		expect(screen.queryByText("FIRST HUNK")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(4);
	});

	it("loads a retained file again after whitespace options change", async () => {
		await mountCommit();
		await openFile("f.ts", "FIRST ORIGINAL");
		await openFile("g.ts", "SECOND ORIGINAL");
		host.seedResponse("diff_commit_file", [file("g.ts", "SECOND FILTERED")]);
		await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
		await screen.findByText("SECOND FILTERED");

		await openFile("f.ts", "FIRST FILTERED");

		expect(screen.queryByText("FIRST ORIGINAL")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(4);
	});

	it("loads a retained file again after context-line options change", async () => {
		await mountCommit();
		await openFile("f.ts", "FIRST SHORT CONTEXT");
		await openFile("g.ts", "SECOND SHORT CONTEXT");
		await fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
		host.preferences.set("diff_context_lines", 10);
		await openFile("g.ts", "SECOND SHORT CONTEXT");
		host.seedResponse("diff_commit_file", [
			file("g.ts", "FILTERED LONG CONTEXT"),
		]);
		await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
		await screen.findByText("FILTERED LONG CONTEXT");
		host.seedResponse("diff_commit_file", [
			file("g.ts", "SECOND LONG CONTEXT"),
		]);
		await fireEvent.click(screen.getByTitle("Ignore whitespace changes"));
		await screen.findByText("SECOND LONG CONTEXT");

		await openFile("f.ts", "FIRST LONG CONTEXT");

		expect(screen.queryByText("FIRST SHORT CONTEXT")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(5);
	});

	it("reads the same path again after the repository changes", async () => {
		const view = await mountCommit();
		await openFile("f.ts", "FIRST REPO");
		await openFile("g.ts", "SECOND REPO");
		await view.rerender({ repoPath: "/other" });

		await openFile("f.ts", "OTHER REPO");

		expect(screen.queryByText("FIRST REPO")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(3);
	});

	it("drops a pending file response after returning to a loaded file", async () => {
		const completed = Promise.withResolvers<void>();
		const sink: PerfSink = {
			async write(lines) {
				const samples: PerfSample[] = lines.map((line) => JSON.parse(line));
				if (
					samples.some(
						(sample) =>
							sample.name === "diff.openCommitFile" &&
							sample.attrs?.path === "g.ts",
					)
				) {
					completed.resolve();
				}
			},
		};
		enablePerf({ sink, frames: false, batchSize: 1, now: () => 0 });
		await mountCommit();
		await openFile("f.ts", "FIRST");
		const pending = host.holdNextReply("diff_commit_file");
		await selectFile("g.ts");
		await pending.entered;

		await selectFile("f.ts");
		await screen.findByText("FIRST");
		pending.release([file("g.ts", "STALE")]);
		await completed.promise;
		await openFile("g.ts", "FRESH");

		expect(screen.getByText("FRESH")).toBeTruthy();
		expect(screen.queryByText("STALE")).toBeNull();
		expect(screen.queryByText("Loading diff…")).toBeNull();
		expect(host.count("diff_commit_file")).toBe(3);
	});

	describe("when a file read fails", () => {
		it("clears the failure when returning to a loaded file", async () => {
			await mountCommit();
			await openFile("f.ts", "FIRST");
			const pending = host.holdNextReply("diff_commit_file");
			await selectFile("g.ts");
			await pending.entered;
			pending.reject({ code: "not_found", message: "File unavailable" });
			await screen.findByRole("button", { name: "Retry" });

			await selectFile("f.ts");
			await screen.findByText("FIRST");

			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			expect(host.count("diff_commit_file")).toBe(2);
		});

		it("retries a failed file through the backend", async () => {
			await mountCommit();
			const pending = host.holdNextReply("diff_commit_file");
			await selectFile("f.ts");
			await pending.entered;
			pending.reject({ code: "not_found", message: "File unavailable" });
			const retry = await screen.findByRole("button", { name: "Retry" });
			host.seedResponse("diff_commit_file", [file("f.ts", "RECOVERED")]);

			await fireEvent.click(retry);
			await screen.findByText("RECOVERED");

			expect(host.count("diff_commit_file")).toBe(2);
		});
	});
});
