import { afterEach, describe, expect, it } from "vitest";
import type { AppDriver } from "./drivers/index.js";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";

const FILE = "src/commented.ts";
const LINES = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`);
const REPOSITORY: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(LINES) },
		{ step: "commit", message: "Add file" },
		{
			step: "file",
			path: FILE,
			content: fileOf(LINES.with(5, "line 6 working tree change")),
		},
	],
};

type Side = "unstaged" | "staged";
type View = "inline" | "side by side" | "full file";

const CASES: { side: Side; view: View }[] = (
	["unstaged", "staged"] as const
).flatMap((side) =>
	(["inline", "side by side", "full file"] as const).map((view) => ({
		side,
		view,
	})),
);

describe("a comment sent on an open working-tree diff", () => {
	afterEach(teardown);

	it.each(CASES)(
		"shows a whole-file comment in the $side diff, $view, without reselecting the file",
		async ({ side, view }) => {
			const app = await setup({ repo: REPOSITORY });
			await openWorkingTreeFile(app, side);
			await showView(app, view);

			await app.review.commentOnFile();
			await app.review.write("split this file up");
			await app.review.submit();

			expect(await commentRowShown(app)).toBe(true);
		},
	);

	it("shows a hunk comment in the unstaged diff without reselecting the file", async () => {
		const app = await setup({ repo: REPOSITORY });
		await openWorkingTreeFile(app, "unstaged");

		await app.review.commentOnHunk(0);
		await app.review.write("this line needs a look");
		await app.review.submit();

		expect(await commentRowShown(app)).toBe(true);
	});
});

async function openWorkingTreeFile(app: AppDriver, side: Side): Promise<void> {
	await app.repo.open();
	await app.staging.open();
	if (side === "unstaged") {
		await app.staging.openFile(FILE);
		return;
	}

	await app.staging.stageFile(FILE);
	await app.staging.openStagedFile(FILE);
}

async function showView(app: AppDriver, view: View): Promise<void> {
	if (view === "side by side") await app.diffPane.showSideBySide();
	if (view === "full file") await app.diffPane.showFullFile();
}

function commentRowShown(app: AppDriver): Promise<true> {
	return app.elapseUntil("the comment row in the diff", () =>
		app.diffPane.showsCommentRow() ? true : null,
	);
}

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}
