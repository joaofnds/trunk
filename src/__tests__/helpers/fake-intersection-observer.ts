/**
 * The browser's IntersectionObserver, which jsdom does not have. It lays
 * nothing out, so a test says which element entered or left its root, as a
 * scroll would. Like the browser, it reports an element's state when it starts
 * observing it, and an element no test placed in view reports outside.
 */
export class FakeIntersectionObserver implements IntersectionObserver {
	static readonly #live = new Set<FakeIntersectionObserver>();
	static readonly #inView = new WeakSet<Element>();

	readonly root: Element | Document | null;
	readonly rootMargin: string;
	readonly scrollMargin = "0px";
	readonly thresholds: readonly number[];
	readonly #callback: IntersectionObserverCallback;
	readonly #observed = new Set<Element>();

	constructor(
		callback: IntersectionObserverCallback,
		options: IntersectionObserverInit = {},
	) {
		this.#callback = callback;
		this.root = options.root ?? null;
		this.rootMargin = options.rootMargin ?? "0px";
		this.thresholds = [options.threshold ?? 0].flat();
		FakeIntersectionObserver.#live.add(this);
	}

	observe(target: Element): void {
		this.#observed.add(target);
		const inView = FakeIntersectionObserver.#inView.has(target);
		queueMicrotask(() => {
			if (this.#observed.has(target))
				this.#callback([entryFor(target, inView, inView ? 1 : 0)], this);
		});
	}

	unobserve(target: Element): void {
		this.#observed.delete(target);
	}

	disconnect(): void {
		this.#observed.clear();
		FakeIntersectionObserver.#live.delete(this);
	}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	/** Report `target` as scrolled into its observers' root. */
	static enter(target: Element): void {
		FakeIntersectionObserver.#inView.add(target);
		FakeIntersectionObserver.#report(entryFor(target, true, 1));
	}

	/** Report `target` as scrolled out of its observers' root. */
	static leave(target: Element): void {
		FakeIntersectionObserver.#inView.delete(target);
		FakeIntersectionObserver.#report(entryFor(target, false, 0));
	}

	/** Report `target` as touching its observers' root at an edge, which the
	 *  browser counts as intersecting with no area inside. */
	static touch(target: Element): void {
		FakeIntersectionObserver.#inView.delete(target);
		FakeIntersectionObserver.#report(entryFor(target, true, 0));
	}

	/** Whether any live observer watches `target`. */
	static observes(target: Element): boolean {
		return [...FakeIntersectionObserver.#live].some((observer) =>
			observer.#observed.has(target),
		);
	}

	static #report(entry: IntersectionObserverEntry): void {
		const { target } = entry;
		for (const observer of FakeIntersectionObserver.#live) {
			if (observer.#observed.has(target)) observer.#callback([entry], observer);
		}
	}
}

function entryFor(
	target: Element,
	isIntersecting: boolean,
	intersectionRatio: number,
): IntersectionObserverEntry {
	const box = target.getBoundingClientRect();
	return {
		target,
		isIntersecting,
		intersectionRatio,
		boundingClientRect: box,
		intersectionRect: box,
		rootBounds: null,
		time: 0,
	};
}
