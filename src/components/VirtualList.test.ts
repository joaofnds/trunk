import { fireEvent, render } from "@testing-library/svelte";
import type { Snippet } from "svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("renders items div with transform style", () => {
		const { container } = render(VirtualList, {
			props: {
				items: Array.from({ length: 10 }, (_, i) => `item-${i}`),
				renderItem: (() => {}) as unknown as Snippet,
				defaultEstimatedItemHeight: 40,
			},
		});
		const itemsDiv = container.querySelector(".virtual-list-items");
		expect(itemsDiv).toBeInTheDocument();
		// The transform should be set (translateY)
		const style = itemsDiv?.getAttribute("style") ?? "";
		expect(style).toContain("transform");
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

		expect(() => {
			for (const frame of frames) frame(0);
		}).not.toThrow();
	});
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
		}).toEqual({ scrolls: "", width: "", clip: "" });
	});
});
