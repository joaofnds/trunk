import { SvelteMap } from "svelte/reactivity";
import type { Thread, ThreadState } from "./types.js";

interface Toggle {
	readonly state: ThreadState;
	readonly changeCount: number;
	readonly collapsed: boolean;
}

/**
 * Which review threads are folded to their header. A settled thread folds and
 * one that still needs the user opens, and a reader's toggle overrides that
 * only until the thread's state next moves, so marking a thread done always
 * folds it.
 */
export class ThreadFolds {
	readonly #toggles = new SvelteMap<string, Toggle>();

	isCollapsed(thread: Thread): boolean {
		const toggle = this.#toggles.get(thread.id);
		if (toggle !== undefined && holds(toggle, thread)) return toggle.collapsed;

		return thread.state === "done" || thread.state === "dismissed";
	}

	toggle(thread: Thread) {
		this.#toggles.set(thread.id, {
			state: thread.state,
			changeCount: changeCountOf(thread),
			collapsed: !this.isCollapsed(thread),
		});
	}
}

function holds(toggle: Toggle, thread: Thread): boolean {
	return (
		toggle.state === thread.state &&
		toggle.changeCount === changeCountOf(thread)
	);
}

function changeCountOf(thread: Thread): number {
	return thread.history?.length ?? 0;
}
