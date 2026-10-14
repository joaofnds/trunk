import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/main.ts";
const ANSWER = "the guard was already there";

const NUMBERED = Array.from({ length: 24 }, (_, at) => `line ${at + 1}`);

const TWO_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(NUMBERED) },
		{ step: "commit", message: "Add main" },
		{
			step: "file",
			path: FILE,
			content: fileOf(NUMBERED.with(2, "line 3 CHANGED")),
		},
		{ step: "commit", message: "Change main" },
	],
};

describe("an agent reply sent through the CLI", () => {
	afterEach(teardown);

	it("raises the header's unread count and leaves the thread open", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		const thread = await createReviewThread(app);

		await app.agent.reply(thread, ANSWER);
		await app.events.reviewStoreChanged();

		await app.elapseUntil("the header's unread count", () =>
			app.review.unreadSummary() === "1 unread thread" ? true : null,
		);
		expect(app.review.states()).toEqual(["open"]);
	});

	it("is marked read once the panel shows it", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		const thread = await createReviewThread(app);
		await app.agent.reply(thread, ANSWER);
		await app.events.reviewStoreChanged();
		await app.elapseUntil("the header's unread count", () =>
			app.review.unreadSummary() === "1 unread thread" ? true : null,
		);

		await app.review.bringReplyIntoView(ANSWER);

		await app.elapseUntil("the header's unread count to clear", () =>
			app.review.unreadSummary() === null ? true : null,
		);
	});
});

async function createReviewThread(
	app: Awaited<ReturnType<typeof setup>>,
): Promise<string> {
	await app.repo.open();
	await app.repo.selectCommit("Change main");
	await app.repo.openCommitFile(FILE);
	await app.review.commentOnHunk(0);
	await app.review.write("does this need a guard?");
	await app.review.submit();
	await app.review.openPanel();

	const [thread] = await waitFor("the review panel's thread", () => {
		const showing = app.review.threadIds();
		return showing.length > 0 ? showing : null;
	});
	return thread;
}

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}
