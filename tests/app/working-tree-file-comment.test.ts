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

interface Side {
	side: string;
	open: (app: AppDriver) => Promise<void>;
}

interface View {
	view: string;
	show: (app: AppDriver) => Promise<void>;
}

const SIDES: Side[] = [
	{ side: "unstaged", open: (app) => app.staging.openFile(FILE) },
	{
		side: "staged",
		open: async (app) => {
			await app.staging.stageFile(FILE);
			await app.staging.openStagedFile(FILE);
		},
	},
];

const VIEWS: View[] = [
	{ view: "inline", show: async () => {} },
	{ view: "side by side", show: (app) => app.diffPane.showSideBySide() },
	{ view: "full file", show: (app) => app.diffPane.showFullFile() },
];

const SIDES_IN_EVERY_VIEW = SIDES.flatMap((side) =>
	VIEWS.map((view) => ({ ...side, ...view })),
);

describe("a comment sent on an open working-tree diff", () => {
	afterEach(teardown);

	it.each(SIDES_IN_EVERY_VIEW)(
		"shows a whole-file comment in the $side diff, $view, without reselecting the file",
		async ({ open, show }) => {
			const app = await openRepository();
			await open(app);
			await show(app);

			await sendWholeFileComment(app, "split this file up");

			const rows = await commentRowsShown(app);
			expect(rows).toEqual([
				expect.stringMatching(/Whole file[\s\S]*split this file up/),
			]);
		},
	);

	it("shows a second whole-file comment on a snapshot the first one already uses", async () => {
		const app = await openRepository();
		await app.staging.openFile(FILE);
		await sendWholeFileComment(app, "split this file up");
		await commentRowsShown(app);

		await sendWholeFileComment(app, "and rename it");

		const shown = await app.elapseUntil(
			"the second comment in the diff",
			() => {
				const text = app.diffPane.commentRows().join("\n");
				return text.includes("and rename it") ? text : null;
			},
		);
		expect(shown).toContain("split this file up");
	});

	it.each(SIDES)(
		"shows a line comment in the $side diff without reselecting the file",
		async ({ open }) => {
			const app = await openRepository();
			await open(app);

			await app.review.selectNewLine(6);
			await app.review.commentOnHunk(0);
			await app.review.write("this line needs a look");
			await app.review.submit();

			const rows = await commentRowsShown(app);
			expect(rows).toEqual([
				expect.stringMatching(/L6 [\s\S]*this line needs a look/),
			]);
		},
	);
});

async function openRepository(): Promise<AppDriver> {
	const app = await setup({ repo: REPOSITORY });
	await app.repo.open();
	await app.staging.open();

	return app;
}

async function sendWholeFileComment(
	app: AppDriver,
	text: string,
): Promise<void> {
	await app.review.commentOnFile();
	await app.review.write(text);
	await app.review.submit();
}

function commentRowsShown(app: AppDriver): Promise<string[]> {
	return app.elapseUntil("the comment row in the diff", () => {
		const rows = app.diffPane.commentRows();
		return rows.length > 0 ? rows : null;
	});
}

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}
