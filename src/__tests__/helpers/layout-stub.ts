/**
 * jsdom reports 0 for every layout property, so a virtualized list renders no
 * rows there and a render that measures anything reads zeros. This stubs the
 * five properties that path touches — `clientWidth`, `clientHeight`,
 * `offsetHeight`, `offsetTop` and `getBoundingClientRect()` — with a shared
 * default box plus per-element overrides.
 *
 * Call `restoreLayout()` in `afterEach`: the stubs sit on the prototypes and
 * would otherwise leak into every later suite.
 */

export interface LayoutBox {
	width: number;
	height: number;
	top: number;
	left: number;
}

const EMPTY: LayoutBox = { width: 0, height: 0, top: 0, left: 0 };

const overrides = new WeakMap<Element, Partial<LayoutBox>>();
let fallback: LayoutBox = EMPTY;
let uninstall: (() => void) | null = null;

export function stubLayout(defaults: Partial<LayoutBox> = {}): void {
	fallback = { ...EMPTY, ...defaults };
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
	uninstall?.();
	uninstall = null;
	fallback = EMPTY;
}

function boxFor(el: Element): LayoutBox {
	return { ...fallback, ...overrides.get(el) };
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
