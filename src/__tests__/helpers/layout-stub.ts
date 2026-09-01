/**
 * jsdom reports 0 for every layout property, so a virtualized list renders no
 * rows there and a render that measures anything reads zeros. This stubs the
 * five properties that path touches — `clientWidth`, `clientHeight`,
 * `offsetHeight`, `offsetTop` and `getBoundingClientRect()` — with a shared
 * default box plus per-element overrides.
 *
 * Call `restoreLayout()` in `afterEach`: the stubs sit on the prototypes and
 * would otherwise leak into every later suite.
 *
 * Calls nest. The prototypes are shared by every caller in a test file, so the
 * descriptors go back only when the last one restores; an inner caller finishing
 * leaves an outer caller's box in place. Tearing them off on the first restore
 * collapsed `graph-render.ts`'s 4000px viewport — it installs at module load and
 * has no teardown to reinstall from — and every render golden after that point
 * truncated to 22 rows and went red for a reason that was not a defect in the
 * graph (TRUNK-52).
 */

export interface LayoutBox {
	width: number;
	height: number;
	top: number;
	left: number;
}

export interface LayoutStubOptions extends Partial<LayoutBox> {
	/** Per-element box, for a test that needs one element to measure
	 *  differently from another without holding a reference to it — a probe
	 *  span created and thrown away inside the code under test, say. */
	measure?: (el: Element) => Partial<LayoutBox> | undefined;
	/** Change the box this caller already installed, instead of taking a frame of
	 *  its own. For a suite that re-stubs mid-test and restores exactly once; a
	 *  new frame there would never be popped. Leave it off when stubbing on behalf
	 *  of someone else, so that restoring uncovers their box (TRUNK-52). */
	replace?: boolean;
}

const EMPTY: LayoutBox = { width: 0, height: 0, top: 0, left: 0 };

const overrides = new WeakMap<Element, Partial<LayoutBox>>();
let uninstall: (() => void) | null = null;

/** One frame per caller holding the stubs installed, innermost last. The
 *  innermost frame answers, and popping it uncovers the one beneath. */
interface LayoutFrame {
	fallback: LayoutBox;
	measure: LayoutStubOptions["measure"];
}
const frames: LayoutFrame[] = [];

function current(): LayoutFrame | undefined {
	return frames[frames.length - 1];
}

export function stubLayout(options: LayoutStubOptions = {}): void {
	const { measure: measureOption, ...defaults } = options;
	const frame: LayoutFrame = {
		fallback: { ...EMPTY, ...defaults },
		measure: measureOption,
	};

	// `replace` is one caller changing its own box: several suites re-stub mid-test
	// to widen it and restore exactly once, and pushing a frame for those would
	// leave frames nothing ever pops. Everything else takes a frame of its own, so
	// that restoring uncovers whatever was underneath rather than stripping it
	// (TRUNK-52). Defaulting the other way would make the dangerous case the quiet
	// one.
	if (options.replace && frames.length > 0) frames[frames.length - 1] = frame;
	else frames.push(frame);

	if (uninstall) return;

	const savedClientWidth = descriptor(HTMLElement.prototype, "clientWidth");
	const savedClientHeight = descriptor(HTMLElement.prototype, "clientHeight");
	const savedOffsetHeight = descriptor(HTMLElement.prototype, "offsetHeight");
	const savedOffsetTop = descriptor(HTMLElement.prototype, "offsetTop");
	const savedRect = descriptor(Element.prototype, "getBoundingClientRect");

	defineGetter("clientWidth", (box) => box.width);
	defineGetter("clientHeight", (box) => box.height);
	defineGetter("offsetHeight", (box) => box.height);
	defineGetter("offsetTop", (box) => box.top);
	Object.defineProperty(Element.prototype, "getBoundingClientRect", {
		configurable: true,
		writable: true,
		value(this: Element): DOMRect {
			return rectOf(boxFor(this));
		},
	});

	uninstall = () => {
		restore(HTMLElement.prototype, "clientWidth", savedClientWidth);
		restore(HTMLElement.prototype, "clientHeight", savedClientHeight);
		restore(HTMLElement.prototype, "offsetHeight", savedOffsetHeight);
		restore(HTMLElement.prototype, "offsetTop", savedOffsetTop);
		restore(Element.prototype, "getBoundingClientRect", savedRect);
	};
}

/** Give one element a box of its own, overriding the shared default. */
export function setLayout(el: Element, box: Partial<LayoutBox>): void {
	overrides.set(el, { ...overrides.get(el), ...box });
}

export function restoreLayout(): void {
	if (frames.length === 0) return;

	frames.pop();
	if (frames.length > 0) return;

	uninstall?.();
	uninstall = null;
}

function boxFor(el: Element): LayoutBox {
	const frame = current();
	if (!frame) return { ...EMPTY, ...overrides.get(el) };

	return { ...frame.fallback, ...frame.measure?.(el), ...overrides.get(el) };
}

function defineGetter(name: string, read: (box: LayoutBox) => number): void {
	Object.defineProperty(HTMLElement.prototype, name, {
		configurable: true,
		get(this: HTMLElement) {
			return read(boxFor(this));
		},
	});
}

function rectOf(box: LayoutBox): DOMRect {
	return {
		x: box.left,
		y: box.top,
		width: box.width,
		height: box.height,
		top: box.top,
		left: box.left,
		right: box.left + box.width,
		bottom: box.top + box.height,
		toJSON: () => ({}),
	} as DOMRect;
}

function descriptor(
	target: object,
	name: string,
): PropertyDescriptor | undefined {
	return Object.getOwnPropertyDescriptor(target, name);
}

function restore(
	target: object,
	name: string,
	saved: PropertyDescriptor | undefined,
): void {
	if (saved) Object.defineProperty(target, name, saved);
	else Reflect.deleteProperty(target, name);
}
