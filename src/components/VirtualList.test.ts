import { fireEvent, render } from "@testing-library/svelte";
import type { Snippet } from "svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreVirtualListLayout,
	stubVirtualListLayout,
} from "../__tests__/helpers/virtual-list-layout.js";
import VirtualList from "./VirtualList.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

// Mock esm-env — BROWSER must be true for VirtualList to initialize
vi.mock("esm-env", () => ({
	BROWSER: true,
	DEV: false,
}));

describe("VirtualList", () => {
	// jsdom limitations:
	// - scrollTop, offsetHeight, scrollHeight are all 0 in jsdom
	// - ResizeObserver is stubbed in vitest-setup.ts (observe/unobserve/disconnect are no-ops)
	// - getBoundingClientRect returns zero-sized rects
	// These limitations mean we cannot test scroll behavior or viewport-based rendering.
	// Tests verify the component mounts without errors and renders basic DOM structure.

	it("renders without crashing with empty items", () => {
		const { container } = render(VirtualList, {
			props: {
				items: [],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		expect(
			container.querySelector(".virtual-list-container"),
		).toBeInTheDocument();
	});

	it("renders container and viewport structure", () => {
		const { container } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		expect(
			container.querySelector(".virtual-list-container"),
		).toBeInTheDocument();
		expect(
			container.querySelector(".virtual-list-viewport"),
		).toBeInTheDocument();
		expect(
			container.querySelector(".virtual-list-content"),
		).toBeInTheDocument();
		expect(container.querySelector(".virtual-list-items")).toBeInTheDocument();
	});
});

// The load-more effect reads a loading latch in its guard and writes it in its
// body. When the latch is reactive state, writing it re-invalidates the effect
// that read it, and the effect re-runs forever inside one microtask flush. That
// is the graph freezing on any repository with more than one page (TRUNK-147).
describe("VirtualList reaching the end of the loaded items", () => {
	// Above any plausible legitimate count, so exceeding it means the effect is
	// feeding itself rather than responding to real scrolling. Without a bound
	// the run hangs instead of failing.
	const RUNAWAY = 50;

	function mountAtLoadingEdge(onLoadMore: () => void) {
		return render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
				hasMore: true,
				loadMoreThreshold: 50,
				onLoadMore,
			},
		});
	}

	it("asks for the next page a bounded number of times", async () => {
		let calls = 0;

		mountAtLoadingEdge(() => {
			calls += 1;
			if (calls > RUNAWAY) throw new Error("load-more effect is unbounded");
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(calls).toBeLessThan(RUNAWAY);
	});
});

// A scroll records its position on the next frame, and a list torn down in
// between, a tab closed mid-scroll, is no longer there to read it from.
describe("VirtualList torn down between a scroll and the next frame", () => {
	const frames: FrameRequestCallback[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		frames.length = 0;
	});

	it("lets the frame pass without reading the list it lost", async () => {
		const { container, unmount } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		await tick();
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
			frames.push(frame);
			return frames.length;
		});
		await fireEvent.scroll(
			container.querySelector(".virtual-list-viewport") as Element,
		);

		unmount();
		const runFrames = () => {
			for (const frame of frames) frame(0);
		};

		expect(frames).not.toHaveLength(0);
		expect(runFrames).not.toThrow();
	});

	it("leaves no scroll frame pending once the list is gone", async () => {
		const pending = fakeFrames();
		const { container, unmount } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		await tick();
		runFrames(pending);
		await fireEvent.scroll(
			container.querySelector(".virtual-list-viewport") as Element,
		);
		expect(pending.size).toBeGreaterThan(0);

		unmount();

		expect(pending.size).toBe(0);
	});

	it("leaves none of its first measuring frames pending once the list is gone", async () => {
		const pending = fakeFrames();
		const { unmount } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		await tick();
		expect(pending.size).toBeGreaterThan(0);

		unmount();

		expect(pending.size).toBe(0);
	});

	it("requests no measuring frame when torn down before its first tick", async () => {
		const pending = fakeFrames();
		const { unmount } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
			},
		});

		unmount();
		await tick();
		await tick();

		expect(pending.size).toBe(0);
	});

	it("leaves no frame of a programmatic scroll pending once the list is gone", async () => {
		const pending = fakeFrames();
		const { component, unmount } = render(VirtualList, {
			props: {
				items: Array.from({ length: 500 }, (_, i) => `item ${i}`),
				renderItem: (() => {}) as unknown as Snippet,
			},
		});
		await tick();
		runFrames(pending);
		// jsdom has no scrollTo, and the scroll's own frame is what this follows.
		Element.prototype.scrollTo = () => {};
		await component.scroll({ index: 400, smoothScroll: false });
		delete (Element.prototype as Partial<Element>).scrollTo;
		expect(pending.size).toBeGreaterThan(0);

		unmount();

		expect(pending.size).toBe(0);
	});

	/** Runs every pending frame, and the frames those request, until none is left. */
	function runFrames(pending: Map<number, FrameRequestCallback>) {
		while (pending.size > 0) {
			const [id, frame] = pending.entries().next().value as [
				number,
				FrameRequestCallback,
			];
			pending.delete(id);
			frame(0);
		}
	}

	/** A frame clock that only holds what was requested and not cancelled. */
	function fakeFrames(): Map<number, FrameRequestCallback> {
		const pending = new Map<number, FrameRequestCallback>();
		let nextId = 1;
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
			const id = nextId++;
			pending.set(id, frame);
			return id;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
			pending.delete(id);
		});
		return pending;
	}
});

describe("VirtualList given the width its content needs", () => {
	function mountWith(minContentWidth?: number) {
		const { container } = render(VirtualList, {
			props: {
				items: ["a", "b", "c"],
				renderItem: (() => {}) as unknown as Snippet,
				minContentWidth,
			},
		});

		return {
			viewport: container.querySelector(
				".virtual-list-viewport",
			) as HTMLElement,
			content: container.querySelector(".virtual-list-content") as HTMLElement,
		};
	}

	it("lays the content out at least that wide, in a viewport that scrolls sideways", () => {
		const { viewport, content } = mountWith(600);

		expect({
			scrolls: viewport.style.overflowX,
			width: content.style.minWidth,
		}).toEqual({ scrolls: "auto", width: "600px" });
	});

	// An overlay drawn inside the content can be wider than the rows, and without
	// the clip that width becomes a sideways range on a list whose rows all fit.
	it("keeps anything drawn past the content's width out of the sideways range", () => {
		const { content } = mountWith(600);

		expect(content.style.overflowX).toBe("clip");
	});

	it("leaves a list given no width to scroll only up and down", () => {
		const { viewport, content } = mountWith(undefined);

		expect({
			scrolls: viewport.style.overflowX,
			width: content.style.minWidth,
			clip: content.style.overflowX,
		}).toEqual({ scrolls: "hidden", width: "", clip: "" });
	});
});

// Native scrolling moves the viewport before the list re-renders, so rows laid
// out in the tall document can leave the view between two renders and WebKit
// paints nothing there (TRUNK-523). The rows paint inside a surface that stays at
// the viewport instead, offset by the position the list last read.
describe("VirtualList scrolled by the native scroller", () => {
	const VIEWPORT = 200;
	const ROW = 20;
	const ROWS = 100;
	const END = ROWS * ROW - VIEWPORT;

	afterEach(() => {
		restoreVirtualListLayout();
	});

	function frame(): Promise<void> {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	async function mountScrolledTo(scrollTop: number) {
		stubVirtualListLayout({ viewportHeight: VIEWPORT, rowHeight: ROW });
		const { container } = render(VirtualList, {
			props: {
				items: Array.from({ length: ROWS }, (_, i) => `item-${i}`),
				renderItem: (() => {}) as unknown as Snippet,
				defaultEstimatedItemHeight: ROW,
				hasMore: false,
			},
		});
		await frame();
		await tick();
		const viewport = container.querySelector(
			".virtual-list-viewport",
		) as HTMLElement;
		viewport.scrollTop = scrollTop;
		viewport.dispatchEvent(new Event("scroll"));
		await frame();
		await tick();

		return container;
	}

	function px(element: Element | null): number {
		return Number.parseFloat((element as HTMLElement | null)?.style.top ?? "");
	}

	/** Where the first mounted row paints, measured from the surface's top. */
	function firstRowPaintsAt(container: Element): { index: number; y: number } {
		const first = container.querySelector<HTMLElement>("[data-original-index]");
		const document = container.querySelector(".virtual-list-document");

		return {
			index: Number(first?.dataset.originalIndex),
			y: px(document) + px(container.querySelector(".virtual-list-items")),
		};
	}

	it("keeps the full scroll extent around a surface the viewport's height", async () => {
		const container = await mountScrolledTo(0);

		const content = container.querySelector<HTMLElement>(
			".virtual-list-content",
		);
		const surface = content?.querySelector<HTMLElement>(
			".virtual-list-surface",
		);

		expect({
			extent: content?.style.height,
			surface: surface?.style.height,
		}).toEqual({ extent: `${ROWS * ROW}px`, surface: `${VIEWPORT}px` });
		expect(surface).toHaveClass("sticky", "overflow-clip");
		expect(surface).toContainElement(
			container.querySelector(".virtual-list-items"),
		);
	});

	it("paints each mounted row where the scroll position it last read puts it", async () => {
		const container = await mountScrolledTo(600);

		const { index, y } = firstRowPaintsAt(container);

		expect(y).toBe(index * ROW - 600);
	});

	it("places the rows by offset, leaving no transform for a layer of its own", async () => {
		const container = await mountScrolledTo(600);

		const items = container.querySelector<HTMLElement>(".virtual-list-items");

		expect(items?.style.transform).toBe("");
	});

	// CommitGraph pads its viewport, and rows scroll through that padding.
	describe("when the viewport is padded", () => {
		const PADDING = 8;
		let style: HTMLStyleElement;

		beforeEach(() => {
			style = document.createElement("style");
			style.textContent = `.virtual-list-viewport { padding-top: ${PADDING}px; padding-bottom: ${PADDING}px; }`;
			document.head.append(style);
		});

		afterEach(() => {
			style.remove();
		});

		it("stretches the surface over the padding the rows scroll through", async () => {
			const container = await mountScrolledTo(600);

			const surface = container.querySelector<HTMLElement>(
				".virtual-list-surface",
			);

			expect({
				top: surface?.style.top,
				height: surface?.style.height,
			}).toEqual({ top: `${-PADDING}px`, height: `${VIEWPORT}px` });
		});

		it("paints each mounted row where it sat below the padding", async () => {
			const container = await mountScrolledTo(600);

			const { index, y } = firstRowPaintsAt(container);

			expect(y).toBe(PADDING + index * ROW - 600);
		});
	});

	describe("when the viewport overscrolls", () => {
		it.each([
			{ edge: "start", scrollTop: -90, shift: 0 },
			{ edge: "end", scrollTop: END + 90, shift: -END },
		])(
			"leaves the native bounce at the $edge out of the rows",
			async ({ scrollTop, shift }) => {
				const container = await mountScrolledTo(scrollTop);

				expect(px(container.querySelector(".virtual-list-document"))).toBe(
					shift,
				);
			},
		);
	});
});
