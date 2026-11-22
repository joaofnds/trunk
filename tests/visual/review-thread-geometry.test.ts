import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RepoSpec } from "../app/harness/host-client.js";
import { SuiteHarness, type VisualHarness } from "./harness.js";

const FILE = "src/review.txt";
const ILLUSTRATION = "https://trunk-review.test.invalid/history.svg";
const lines = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`);
const EDITED: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: `${lines.join("\n")}\n` },
		{ step: "commit", message: "base" },
		{
			step: "file",
			path: FILE,
			content: `${lines.with(2, "Edited line").join("\n")}\n`,
		},
	],
};

describe.concurrent("inline review history", () => {
	const suite = new SuiteHarness();
	let harness: VisualHarness;

	beforeAll(async () => {
		harness = await suite.start({ cases: [], pages: 2 });
	});

	afterAll(() => suite.teardown());

	test.for([
		{ length: "fits within the viewport", paragraphs: 4, scrollable: false },
		{ length: "spans several viewports", paragraphs: 64, scrollable: true },
	])(
		"reaches the latest reply and composer when the expanded history $length",
		async ({ paragraphs, scrollable }, context) => {
			const olderParagraphs = Array.from({ length: paragraphs }, (_, index) =>
				index === 0 ? "Reply 1" : `Paragraph ${index + 1}.`,
			);
			if (scrollable)
				olderParagraphs.splice(1, 0, `![Illustration](${ILLUSTRATION})`);
			const oldest = olderParagraphs.join("\n\n");

			await harness.readInlineReview(
				EDITED,
				FILE,
				[oldest, "Reply 2", "Reply 3", "Reply 4", "Reply 5"],
				context,
				async (review) => {
					const showImage = scrollable
						? await review.delayIllustration(ILLUSTRATION)
						: null;
					await review.expandEarlierReplies("Reply 1");

					if (showImage) {
						const paragraph = "Paragraph 32.";
						const offset = 4;
						await review.readFromParagraph(paragraph, offset);
						const before = await review.paragraphPosition(paragraph);
						expect(Math.abs(before.offset - offset)).toBeLessThan(1);
						await showImage();
						const afterImage = await review.paragraphPosition(paragraph);
						expect(afterImage.scrollLimit).toBeGreaterThan(before.scrollLimit);
						expect(Math.abs(afterImage.offset - before.offset)).toBeLessThan(1);

						await review.switchToUnified();

						const after = await review.paragraphPosition(paragraph);
						expect(
							Math.abs(after.offset - before.offset),
							JSON.stringify({ before, after }),
						).toBeLessThan(1);
					}

					await review.scrollToEnd();

					expect(await review.tail("Reply 5")).toEqual({
						latestReply: true,
						composer: true,
						scrollable,
					});

					if (scrollable) {
						await review.backToRecentReplies();

						expect(await review.focusedReply()).toBe("Reply 3");
						expect(await review.replyTexts()).toEqual([
							"Reply 3",
							"Reply 4",
							"Reply 5",
						]);
						expect(await review.tail("Reply 5")).toEqual({
							latestReply: true,
							composer: true,
							scrollable: false,
						});
					} else {
						await review.collapseEarlierRepliesFromKeyboard();

						expect(await review.earlierRepliesToggleHasFocus()).toBe(true);
						expect(await review.tail("Reply 5")).toEqual({
							latestReply: true,
							composer: true,
							scrollable: false,
						});
					}
				},
			);
		},
	);
});
