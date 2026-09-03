import { afterEach, describe, expect, it } from "vitest";
import { BODY_CLAMP_LINES } from "../../src/lib/commit-body-clamp.js";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const LONG_BODY = Array.from(
	{ length: BODY_CLAMP_LINES + 12 },
	(_, i) => `body line ${i}`,
).join("\n");

/** Two commits, one with a body far past the clamp and one with none, so a
 *  single repository shows both the clamped and the unclamped case and the
 *  selection can move between them. */
const LONG_MESSAGE: RepoSpec = {
	steps: [
		{ step: "file", path: "first.txt", content: "one\n" },
		{ step: "commit", message: "short subject" },
		{ step: "file", path: "second.txt", content: "two\n" },
		{ step: "commit", message: `long subject\n\n${LONG_BODY}` },
	],
};

const BODY = '[data-testid="commit-body"]';

function body(): HTMLElement | null {
	return document.querySelector<HTMLElement>(BODY);
}

function toggle(): HTMLButtonElement | null {
	const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
	return (
		buttons.find((b) =>
			/^Show (more|less)$/.test(b.textContent?.trim() ?? ""),
		) ?? null
	);
}

async function openLongCommit() {
	const app = await setup({ repo: LONG_MESSAGE });
	await app.repo.open();
	await app.repo.selectCommit("long subject");
	await waitFor("the commit body", () => body());
	await app.settled();
	return app;
}

describe("a commit body longer than the panel shows", () => {
	afterEach(teardown);

	// The defect this guards: the body, the notes and the file list share one
	// scroller, so an unclamped long body pushed the file list past the bottom
	// of the panel and the reader had to scroll the message to reach the files.
	it("clamps, and the reader can open it and close it again", async () => {
		const app = await openLongCommit();

		expect(body()?.dataset.clamped).toBe("true");
		expect(toggle()?.textContent?.trim()).toBe("Show more");

		toggle()?.click();
		await app.settled();
		expect(body()?.dataset.clamped).toBe("false");
		expect(toggle()?.textContent?.trim()).toBe("Show less");

		toggle()?.click();
		await app.settled();
		expect(body()?.dataset.clamped).toBe("true");
	});

	// An inner scroller here would be an inline scroll area inside the panel's
	// own scroller: the wheel would have two places to go on one axis, and the
	// file list would stay just as far down (TRUNK-127 is the same rule for the
	// diff pane).
	it("does not add a second vertical scroller in the detail panel", async () => {
		await openLongCommit();

		const start = body();
		if (!start) throw new Error("no commit body");

		const scrolls = (value: string) => value === "auto" || value === "scroll";
		let scrollers = 0;
		for (let el = start.parentElement; el; el = el.parentElement) {
			const style = getComputedStyle(el);
			if (scrolls(style.overflowY) || scrolls(style.overflow)) scrollers++;
		}
		// The panel's own scroller, and nothing between it and the body.
		expect(scrollers).toBe(1);
		expect(scrolls(getComputedStyle(start).overflowY)).toBe(false);
	});

	it("leaves the file list rendered while the body is clamped", async () => {
		const app = await openLongCommit();

		expect(body()?.dataset.clamped).toBe("true");
		expect(app.repo.commitFiles().join(" ")).toContain("second.txt");
	});

	it("offers no control on a commit whose message is only a subject", async () => {
		const app = await setup({ repo: LONG_MESSAGE });
		await app.repo.open();
		await app.repo.selectCommit("short subject");
		await app.settled();

		expect(body()).toBeNull();
		expect(toggle()).toBeNull();
	});

	it("clamps again when the reader moves to another commit", async () => {
		const app = await openLongCommit();

		toggle()?.click();
		await app.settled();
		expect(body()?.dataset.clamped).toBe("false");

		await app.repo.selectCommit("short subject");
		await app.settled();
		await app.repo.selectCommit("long subject");
		await waitFor("the commit body", () => body());
		await app.settled();

		expect(body()?.dataset.clamped).toBe("true");
	});
});
