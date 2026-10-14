/**
 * The browser's IntersectionObserver, which jsdom does not have. It lays
 * nothing out, so it reports nothing on its own: a test says which observed
 * element entered or left its root, as a scroll would.
 */
export class FakeIntersectionObserver implements IntersectionObserver {
	static readonly #live = new Set<FakeIntersectionObserver>();

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
		FakeIntersectionObserver.#report(target, true);
	}

	/** Report `target` as scrolled out of its observers' root. */
	static leave(target: Element): void {
		FakeIntersectionObserver.#report(target, false);
	}

	/** Whether any live observer watches `target`. */
	static observes(target: Element): boolean {
		return [...FakeIntersectionObserver.#live].some((observer) =>
			observer.#observed.has(target),
		);
	}

	static #report(target: Element, intersecting: boolean): void {
		const box = target.getBoundingClientRect();
		const entry: IntersectionObserverEntry = {
			target,
			isIntersecting: intersecting,
			intersectionRatio: intersecting ? 1 : 0,
			boundingClientRect: box,
			intersectionRect: box,
			rootBounds: null,
			time: 0,
		};

		for (const observer of FakeIntersectionObserver.#live) {
			if (observer.#observed.has(target)) observer.#callback([entry], observer);
		}
	}
}
