import { SvelteMap } from "svelte/reactivity";
import type { Thread, ThreadState } from "./types.js";

type Folded = Pick<Thread, "id" | "state" | "history">;

interface Toggle {
	state: ThreadState;
	changes: number;
	collapsed: boolean;
}

/**
 * Which review threads are folded to their header. A settled thread folds and
 * one that still needs the user opens, and a reader's toggle overrides that
 * only until the thread's state next moves, so marking a thread done always
 * folds it. Two cards drawing one thread, as an inline card and its measured
 * copy do, share one instance so they fold together.
 */
export class ThreadFolds {
	readonly #toggles = new SvelteMap<string, Toggle>();

	isCollapsed(thread: Folded): boolean {
		const toggle = this.#toggles.get(thread.id);
		if (toggle !== undefined && holds(toggle, thread)) return toggle.collapsed;

		return thread.state === "done" || thread.state === "dismissed";
	}

	toggle(thread: Folded) {
		this.#toggles.set(thread.id, {
			state: thread.state,
			changes: changeCount(thread),
			collapsed: !this.isCollapsed(thread),
		});
	}
}

function holds(toggle: Toggle, thread: Folded): boolean {
	return (
		toggle.state === thread.state && toggle.changes === changeCount(thread)
	);
}

function changeCount(thread: Folded): number {
	return thread.history?.length ?? 0;
}
