import { render } from "@testing-library/svelte";
import type { Snippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
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
