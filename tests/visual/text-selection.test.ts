import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RepoSpec } from "../app/harness/host-client.js";
import { SuiteHarness, type VisualHarness } from "./harness.js";

const FILE = "src/sample.ts";
const before = "const start = 1;\nconst previous = 2;\n\nconst finish = 3;\n";
const after = before.replace("previous", "current");
const EDITED: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: before },
		{ step: "commit", message: "base" },
		{ step: "file", path: FILE, content: after },
	],
};

describe("diff text selection", () => {
	const suite = new SuiteHarness();
	let harness: VisualHarness;

	beforeAll(async () => {
		harness = await suite.start({ cases: [], pages: 1 });
	});
	afterAll(() => suite.teardown());

	test.for([
		{
			view: { layout: "inline" as const },
			lines: [
				"nst start = 1;",
				"const previous = 2;",
				"const current = 2;",
				"",
			],
			underlinedWords: ["previous", "current"],
		},
		{
			view: { layout: "split" as const, crossColumns: true },
			lines: ["nst start = 1;", "const current = 2;", ""],
			underlinedWords: ["current"],
		},
	])(
		"draws an unbroken $view.layout selection without end marks",
		async ({ view, lines, underlinedWords }, context) => {
			const selection = await harness.dragDiffText(
				EDITED,
				FILE,
				view,
				["const start", "const finish"],
				context,
			);

			expect(selection).toEqual({
				copied: `${lines.join("\n")}\n`,
				visible: true,
				fills: lines.map(() => 1),
				endMarks: false,
				underlinedWords,
				gaps: lines.slice(1).map(() => 0),
			});
		},
	);

	test("keeps the highlight continuous through word wrap", async (context) => {
		const longLine = `const current = "${"word ".repeat(48)}";`;
		const repo: RepoSpec = {
			steps: [
				{ step: "file", path: FILE, content: before },
				{ step: "commit", message: "base" },
				{
					step: "file",
					path: FILE,
					content: after.replace("const current = 2;", longLine),
				},
			],
		};

		const selection = await harness.dragDiffText(
			repo,
			FILE,
			{ layout: "inline", wrap: true },
			["const start", "const finish"],
			context,
		);

		expect(selection.visible).toBe(true);
		expect(selection.fills.length).toBeGreaterThan(4);
		expect(selection.fills.every((fill) => fill === 1)).toBe(true);
		expect(selection.gaps.every((gap) => gap === 0)).toBe(true);
		expect(selection.copied).toBe(
			`nst start = 1;\nconst previous = 2;\n${longLine}\n\n`,
		);
	});
});
