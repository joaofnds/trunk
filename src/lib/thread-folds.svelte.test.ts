import { describe, expect, it } from "vitest";
import { aStateChange, aThread } from "../__tests__/helpers/thread-fixture.js";
import { ThreadFolds } from "./thread-folds.svelte.js";
import type { Thread, ThreadState } from "./types.js";

function moved(thread: Thread, state: ThreadState): Thread {
	return {
		...thread,
		state,
		history: [
			...(thread.history ?? []),
			aStateChange({ state, channel: "human" }),
		],
	};
}

describe(ThreadFolds, () => {
	it.each(["open", "addressed"] as const)("opens a %s thread", (state) => {
		expect(new ThreadFolds().isCollapsed(aThread({ state }))).toBe(false);
	});

	it.each(["done", "dismissed"] as const)("folds a %s thread", (state) => {
		expect(new ThreadFolds().isCollapsed(aThread({ state }))).toBe(true);
	});

	it("folds a thread the reader toggles", () => {
		const folds = new ThreadFolds();
		const thread = aThread({ state: "open" });

		folds.toggle(thread);

		expect(folds.isCollapsed(thread)).toBe(true);
	});

	it("keeps each thread's toggle apart", () => {
		const folds = new ThreadFolds();

		folds.toggle(aThread({ id: "a", state: "open" }));

		expect(folds.isCollapsed(aThread({ id: "b", state: "open" }))).toBe(false);
	});

	it("folds a thread once it is resolved, though the reader had opened it", () => {
		const folds = new ThreadFolds();
		const done = aThread({ state: "done" });
		folds.toggle(done);

		const doneAgain = moved(moved(done, "open"), "done");

		expect(folds.isCollapsed(doneAgain)).toBe(true);
	});

	it("opens a thread once it is reopened, though the reader had folded it", () => {
		const folds = new ThreadFolds();
		const open = aThread({ state: "open" });
		folds.toggle(open);

		expect(folds.isCollapsed(moved(open, "addressed"))).toBe(false);
	});

	it("keeps a toggle through an edit that moves no state", () => {
		const folds = new ThreadFolds();
		const open = aThread({ state: "open", text: "first" });
		folds.toggle(open);

		const edited: Thread = { ...open, text: "second" };

		expect(folds.isCollapsed(edited)).toBe(true);
	});
});
