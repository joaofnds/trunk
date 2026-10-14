import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";
import { SvelteSet } from "svelte/reactivity";
import type { Reply, Thread } from "./types.js";

/** An agent reply the app has not yet shown the user. */
export function isUnseen(reply: Reply): boolean {
	return reply.channel === "agent" && !reply.seen;
}

export function unseenAgentReplies(thread: Thread): readonly Reply[] {
	return thread.replies.filter(isUnseen);
}

/** A thread holding an agent reply the app has not shown the user yet. */
export function isUnread(thread: Thread): boolean {
	return unseenAgentReplies(thread).length > 0;
}

/** The ids of the watched elements that show some of their area in a root. */
class InView {
	readonly ids = new SvelteSet<string>();
	readonly #targets = new Map<Element, string>();
	#observer: IntersectionObserver | null = null;

	watch(id: string): Attachment<HTMLElement> {
		return (element) => {
			this.#targets.set(element, id);
			this.#observer?.observe(element);

			return () => {
				this.#targets.delete(element);
				this.#observer?.unobserve(element);
				this.ids.delete(id);
			};
		};
	}

	connect(root: HTMLElement, topInset: number): () => void {
		// A second threshold just past 0 reports an element that merely touched
		// the root's edge again once it shows real area inside.
		this.#observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) this.#record(entry);
			},
			{ root, rootMargin: `-${topInset}px 0px 0px 0px`, threshold: [0, 0.001] },
		);
		for (const element of this.#targets.keys()) this.#observer.observe(element);

		return () => {
			this.#observer?.disconnect();
			this.#observer = null;
			this.ids.clear();
		};
	}

	#record(entry: IntersectionObserverEntry) {
		const id = this.#targets.get(entry.target);
		if (id === undefined) return;

		if (entry.isIntersecting && entry.intersectionRatio > 0) this.ids.add(id);
		else this.ids.delete(id);
	}
}

/**
 * Which thread cards and which agent replies the review panel shows inside its
 * scrolling body. The panel provides it to the cards it draws, so a card drawn
 * anywhere else, inline in a diff, is never watched and never marks a reply.
 */
export class ReviewVisibility {
	readonly cards = new InView();
	readonly replies = new InView();

	/** Watch inside `root`, below the `topInset` pixels its sticky bars cover. */
	connect(root: HTMLElement, topInset: number): () => void {
		const cards = this.cards.connect(root, topInset);
		const replies = this.replies.connect(root, topInset);

		return () => {
			cards();
			replies();
		};
	}
}

const KEY = Symbol("review-visibility");

export function provideReviewVisibility(visibility: ReviewVisibility): void {
	setContext(KEY, visibility);
}

export function reviewVisibility(): ReviewVisibility | undefined {
	return getContext<ReviewVisibility | undefined>(KEY);
}
