import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";
import { SvelteSet } from "svelte/reactivity";

/** The ids of the watched elements that show some of their area in a root. */
class InView {
	readonly ids = new SvelteSet<string>();
	readonly #targets = new Map<Element, string>();
	// One attachment per id, so a refresh that hands a component a new object
	// for the same thread or reply keeps its element watched rather than
	// dropping it from view until the observer next reports.
	readonly #watches = new Map<string, Attachment<HTMLElement>>();
	#observer: IntersectionObserver | null = null;

	watch(id: string): Attachment<HTMLElement> {
		const known = this.#watches.get(id);
		if (known) return known;

		const watch: Attachment<HTMLElement> = (element) => {
			this.#targets.set(element, id);
			this.#observer?.observe(element);

			return () => {
				this.#targets.delete(element);
				this.#observer?.unobserve(element);
				this.ids.delete(id);
			};
		};
		this.#watches.set(id, watch);
		return watch;
	}

	connect(root: HTMLElement, topInset: number): () => void {
		// A second threshold just past 0 reports an element that merely touched
		// the root's edge again once it shows real area inside. It is the
		// smallest ratio above 0, because one pixel of a tall reply is a ratio
		// far below any round number, and a crossing the observer never reports
		// leaves that reply unread while the user reads it.
		this.#observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) this.#record(entry);
			},
			{
				root,
				rootMargin: `-${topInset}px 0px 0px 0px`,
				threshold: [0, Number.EPSILON],
			},
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
