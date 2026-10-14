/**
 * The browser's IntersectionObserver, which jsdom does not have. It lays
 * nothing out, so a test says how much of an element shows in its root, as a
 * scroll would. Like the browser, it reports an element's state when it starts
 * observing it, an element no test placed in view reports outside, and a later
 * change reaches an observer only when it crosses one of that observer's
 * thresholds.
 */
export class FakeIntersectionObserver implements IntersectionObserver {
	static readonly #live = new Set<FakeIntersectionObserver>();
	static readonly #placed = new WeakMap<Element, Placement>();

	readonly root: Element | Document | null;
	readonly rootMargin: string;
	readonly scrollMargin = "0px";
	readonly thresholds: readonly number[];
	readonly #callback: IntersectionObserverCallback;
	// The threshold index each observed element last reported at, as the
	// browser keeps it: -1 outside, else the count of thresholds its ratio
	// reached.
	readonly #observed = new Map<Element, number | null>();

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
		this.#observed.set(target, null);
		const placement = FakeIntersectionObserver.#placed.get(target) ?? OUTSIDE;
		queueMicrotask(() => this.#deliver(target, placement));
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

	/** Report `target` as scrolled wholly into its observers' root. */
	static enter(target: Element): void {
		FakeIntersectionObserver.#place(target, {
			kind: "seen",
			isIntersecting: true,
			ratio: 1,
		});
	}

	/** Report `target` as scrolled out of its observers' root. */
	static leave(target: Element): void {
		FakeIntersectionObserver.#place(target, OUTSIDE);
	}

	/** Report `target` as touching its observers' root at an edge, which the
	 *  browser counts as intersecting with no area inside. */
	static touch(target: Element): void {
		FakeIntersectionObserver.#place(target, {
			kind: "seen",
			isIntersecting: true,
			ratio: 0,
		});
	}

	/** Report `target` as showing `ratio` of its area inside its observers'
	 *  root, as a tall element does when one pixel of it scrolls in. */
	static reveal(target: Element, ratio: number): void {
		FakeIntersectionObserver.#place(target, {
			kind: "seen",
			isIntersecting: true,
			ratio,
		});
	}

	/** Report `target` as spanning `top` to `bottom` pixels below its observers'
	 *  root's top edge. Each observer clips the span by the top of its own
	 *  `rootMargin`, as the browser does, so one span can show some area to an
	 *  observer with a small inset and none to one whose inset covers it. */
	static span(target: Element, span: { top: number; bottom: number }): void {
		FakeIntersectionObserver.#place(target, { kind: "span", ...span });
	}

	/** Whether any live observer watches `target`. */
	static observes(target: Element): boolean {
		return [...FakeIntersectionObserver.#live].some((observer) =>
			observer.#observed.has(target),
		);
	}

	static #place(target: Element, placement: Placement): void {
		FakeIntersectionObserver.#placed.set(target, placement);
		for (const observer of FakeIntersectionObserver.#live)
			observer.#deliver(target, placement);
	}

	#deliver(target: Element, placement: Placement): void {
		if (!this.#observed.has(target)) return;

		const { isIntersecting, ratio } = this.#seen(placement);
		const index = isIntersecting
			? this.thresholds.filter((threshold) => threshold <= ratio).length
			: -1;
		if (this.#observed.get(target) === index) return;

		this.#observed.set(target, index);
		this.#callback([entryFor(target, isIntersecting, ratio)], this);
	}

	#seen(placement: Placement): Seen {
		if (placement.kind === "seen") return placement;

		const edge = -Number.parseFloat(this.rootMargin);
		const shown = placement.bottom - Math.max(placement.top, edge);
		if (shown < 0) return OUTSIDE;

		return {
			kind: "seen",
			isIntersecting: true,
			ratio: shown / (placement.bottom - placement.top),
		};
	}
}

/** What every observer sees of an element, whatever its root margin. */
interface Seen {
	kind: "seen";
	isIntersecting: boolean;
	ratio: number;
}

/** Where an element sits below the root's top edge, which each observer sees
 *  through its own root margin. */
interface Span {
	kind: "span";
	top: number;
	bottom: number;
}

type Placement = Seen | Span;

const OUTSIDE: Seen = { kind: "seen", isIntersecting: false, ratio: 0 };

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
