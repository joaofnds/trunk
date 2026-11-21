import { render } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	setLayout,
	stubLayout,
} from "../../__tests__/helpers/layout-stub";
import ExactVirtualList from "./ExactVirtualList.svelte";

const ROW_HEIGHT = 18;
const VIEWPORT_HEIGHT = 200;

afterEach(() => {
	restoreLayout();
	FakeResizeObserver.reset();
	vi.unstubAllGlobals();
});

class FakeResizeObserver implements ResizeObserver {
	static readonly #live = new Set<FakeResizeObserver>();
	readonly #observed = new Set<Element>();
	readonly #callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.#callback = callback;
	}

	observe(target: Element): void {
		this.#observed.add(target);
		FakeResizeObserver.#live.add(this);
	}

	unobserve(target: Element): void {
		this.#observed.delete(target);
	}

	disconnect(): void {
		this.#observed.clear();
		FakeResizeObserver.#live.delete(this);
	}

	static resize(target: Element): void {
		const contentRect = target.getBoundingClientRect();
		const box = {
			blockSize: contentRect.height,
			inlineSize: contentRect.width,
		};
		const entry: ResizeObserverEntry = {
			target,
			contentRect,
			borderBoxSize: [box],
			contentBoxSize: [box],
			devicePixelContentBoxSize: [box],
		};

		for (const observer of FakeResizeObserver.#live) {
			if (!observer.#observed.has(target)) continue;

			observer.#callback([entry], observer);
		}
	}

	static reset(): void {
		for (const observer of FakeResizeObserver.#live) observer.disconnect();
	}
}

const renderItem = createRawSnippet<[unknown, number]>((_, index) => ({
	render: () => `<div class="row" data-index="${index()}"></div>`,
}));

function mountList(count: number, rowHeight: number = ROW_HEIGHT) {
	return mountHeights(Array.from({ length: count }, () => rowHeight));
}

function mountHeights(heights: (number | string)[], trailingSpace = 0) {
	stubLayout({ width: 800, height: VIEWPORT_HEIGHT });

	return render(ExactVirtualList, {
		props: {
			items: heights.map((_, index) => index),
			heights,
			contentWidth: "1000px",
			trailingSpace,
			renderItem,
		},
	});
}

function heightOf(container: Element, selector: string): string | undefined {
	return container.querySelector<HTMLElement>(selector)?.style.height;
}

function viewportOf(container: Element): HTMLElement {
	return container.querySelector(".exact-virtual-viewport") as HTMLElement;
}

function rowIndices(container: Element): number[] {
	return Array.from(container.querySelectorAll<HTMLElement>(".row"), (row) =>
		Number(row.dataset.index),
	);
}

function rowsTop(container: Element): string | undefined {
	return container.querySelector<HTMLElement>(".exact-virtual-rows")?.style.top;
}

describe("ExactVirtualList", () => {
	it("allocates scroll space from the live height of a row outside the code window", async () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const heights: (number | string)[] = Array.from(
			{ length: 500 },
			() => ROW_HEIGHT,
		);
		heights[300] = "conversation";
		const { container } = mountHeights(heights);
		const row = container.querySelector("[data-index='300']")?.parentElement;
		const content = () => heightOf(container, ".exact-virtual-content");

		expect(content()).toBe("9182px");
		expect(container.querySelectorAll(".row")).toHaveLength(24);
		if (!row) throw new Error("Missing conversation row");

		expect(row.inert).toBe(true);
		setLayout(row, { height: 500.5 });
		FakeResizeObserver.resize(row);
		await tick();

		expect(content()).toBe("9482.5px");
		expect(container.querySelector("[data-index='300']")?.parentElement).toBe(
			row,
		);
	});

	it("jumps past a resized conversation before its observer has reported", async () => {
		const heights: (number | string)[] = Array.from(
			{ length: 500 },
			() => ROW_HEIGHT,
		);
		heights[300] = "conversation";
		const { component, container } = mountHeights(heights);
		const row = container.querySelector("[data-index='300']")?.parentElement;
		if (!row) throw new Error("Missing conversation row");
		setLayout(row, { height: 500 });

		component.scrollToIndex(350);
		await tick();
		await tick();

		expect(viewportOf(container).scrollTop).toBe(349 * ROW_HEIGHT + 500);
	});

	it("mounts the rows covering the viewport plus one screen of runway", () => {
		const { container } = mountList(5000);

		expect(container.querySelectorAll(".row").length).toBe(23);
	});

	it("keeps the mounted count independent of the list's length", () => {
		const { container } = mountList(50_000);

		expect(container.querySelectorAll(".row").length).toBeLessThan(200);
	});

	it("preserves the full scroll extent around a viewport-height row surface", () => {
		const { container } = mountList(5000);

		const content = container.querySelector<HTMLElement>(
			".exact-virtual-content",
		);
		const surface = content?.querySelector<HTMLElement>(
			".exact-virtual-surface",
		);

		expect(content?.style.height).toBe(`${5000 * ROW_HEIGHT}px`);
		expect(surface?.style.height).toBe(`${VIEWPORT_HEIGHT}px`);
		expect(surface).toContainElement(
			container.querySelector(".exact-virtual-rows"),
		);
	});

	it("stretches the rows container to the full content width", () => {
		const { container } = mountList(5000);

		const rows = container.querySelector(".exact-virtual-rows");

		expect(rows).toHaveClass("min-w-full");
	});

	it("suppresses horizontal overscroll chaining on the viewport", () => {
		const { container } = mountList(5000);

		expect(viewportOf(container)).toHaveClass("overscroll-x-none");
	});

	it("publishes the viewport's horizontal offset for the rows to pan from", async () => {
		const { container } = mountList(5000);
		const viewport = viewportOf(container);

		viewport.scrollLeft = 420;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();

		expect(
			container.querySelector(".exact-virtual-rows")?.getAttribute("style"),
		).toContain("--pan-x: 420px");
	});

	it("keeps the horizontal offset published across a vertical scroll", async () => {
		const { container } = mountList(5000);
		const viewport = viewportOf(container);

		viewport.scrollLeft = 420;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();
		viewport.scrollTop = 100 * ROW_HEIGHT;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();

		const style =
			container.querySelector(".exact-virtual-rows")?.getAttribute("style") ??
			"";
		expect(style).toContain("--pan-x: 420px");
		expect(style).toContain("top:");
	});

	it.each([
		{
			position: "middle",
			scrollTop: 450,
			indices: [3, 4, 5, 6, 7, 8, 9],
			top: -300,
		},
		{ position: "end", scrollTop: 800, indices: [7, 8, 9, 10], top: -220 },
	])(
		"positions variable-height rows within the viewport at the $position",
		async ({ scrollTop, indices, top }) => {
			const { container } = mountHeights([
				40, 80, 30, 150, 60, 140, 80, 120, 50, 150, 100,
			]);
			const viewport = viewportOf(container);

			viewport.scrollTop = scrollTop;
			viewport.dispatchEvent(new Event("scroll"));
			await tick();

			expect(rowIndices(container)).toEqual(indices);
			expect(rowsTop(container)).toBe(`${top}px`);
		},
	);

	describe("when the viewport resizes while scrolled", () => {
		it.each([
			{
				direction: "grows",
				height: 400,
				firstIndex: 22,
				count: 67,
				top: -404,
			},
			{
				direction: "shrinks",
				height: 100,
				firstIndex: 38,
				count: 18,
				top: -116,
			},
		])(
			"updates the row window and surface height as it $direction",
			async ({ height, firstIndex, count, top }) => {
				vi.stubGlobal("ResizeObserver", FakeResizeObserver);
				const { container } = mountList(5000);
				const viewport = viewportOf(container);
				viewport.scrollTop = 800;
				viewport.dispatchEvent(new Event("scroll"));
				await tick();

				setLayout(viewport, { height });
				FakeResizeObserver.resize(viewport);
				await tick();

				expect(rowIndices(container)).toEqual(
					Array.from({ length: count }, (_, index) => firstIndex + index),
				);
				expect(rowsTop(container)).toBe(`${top}px`);
				expect(
					container.querySelector<HTMLElement>(".exact-virtual-surface")?.style
						.height,
				).toBe(`${height}px`);
			},
		);
	});

	describe("when the viewport overscrolls", () => {
		it.each([
			{ edge: "start", scrollTop: -90, indices: [0, 1, 2, 3, 4, 5], top: 0 },
			{ edge: "end", scrollTop: 920, indices: [7, 8, 9, 10], top: -220 },
		])(
			"leaves native bounce at the $edge out of the rendered window",
			async ({ scrollTop, indices, top }) => {
				const { container } = mountHeights([
					40, 80, 30, 150, 60, 140, 80, 120, 50, 150, 100,
				]);
				const viewport = viewportOf(container);

				viewport.scrollTop = scrollTop;
				viewport.dispatchEvent(new Event("scroll"));
				await tick();

				expect(viewport.scrollTop).toBe(scrollTop);
				expect(rowIndices(container)).toEqual(indices);
				expect(rowsTop(container)).toBe(`${top}px`);
			},
		);
	});

	describe("when the content is shorter than the viewport", () => {
		it.each([
			{
				content: "short",
				heights: [40, 80, 30],
				height: 150,
				indices: [0, 1, 2],
			},
			{ content: "empty", heights: [], height: 0, indices: [] },
		])(
			"keeps the $content surface within its scroll extent",
			async ({ heights, height, indices }) => {
				const { container } = mountHeights(heights);
				const viewport = viewportOf(container);

				viewport.scrollTop = 50;
				viewport.dispatchEvent(new Event("scroll"));
				await tick();

				expect(
					container.querySelector<HTMLElement>(".exact-virtual-content")?.style
						.height,
				).toBe(`${height}px`);
				expect(
					container.querySelector<HTMLElement>(".exact-virtual-surface")?.style
						.height,
				).toBe(`${height}px`);
				expect(rowIndices(container)).toEqual(indices);
				expect(rowsTop(container)).toBe("0px");
			},
		);
	});

	describe("when it keeps space after its last row", () => {
		const TRAILING_SPACE = 20;

		it("adds the space to the scroll extent", () => {
			const { container } = mountHeights(
				Array.from({ length: 5000 }, () => ROW_HEIGHT),
				TRAILING_SPACE,
			);

			expect(heightOf(container, ".exact-virtual-content")).toBe(
				`${5000 * ROW_HEIGHT + TRAILING_SPACE}px`,
			);
		});

		it("sizes a short list's surface to hold the space", () => {
			const { container } = mountHeights([40, 80, 30], TRAILING_SPACE);

			expect(heightOf(container, ".exact-virtual-surface")).toBe(
				`${150 + TRAILING_SPACE}px`,
			);
		});

		it("lets the last row scroll up through the space and no further", async () => {
			const { container } = mountHeights(
				[40, 80, 30, 150, 60, 140, 80, 120, 50, 150, 100],
				TRAILING_SPACE,
			);
			const viewport = viewportOf(container);

			viewport.scrollTop = 920;
			viewport.dispatchEvent(new Event("scroll"));
			await tick();

			expect(rowsTop(container)).toBe("-240px");
		});

		it("keeps no space when there is no row to follow", () => {
			const { container } = mountHeights([], TRAILING_SPACE);

			expect(heightOf(container, ".exact-virtual-content")).toBe("0px");
		});
	});

	describe("when the content shrinks while scrolled", () => {
		it("fills the new final viewport before the browser reports its clamped scroll offset", async () => {
			const { container, rerender } = mountList(5000);
			const viewport = viewportOf(container);
			viewport.scrollTop = 800;
			viewport.dispatchEvent(new Event("scroll"));
			await tick();

			await rerender({
				items: [0, 1, 2, 3],
				heights: [40, 80, 30, 150],
			});

			expect(rowIndices(container)).toEqual([0, 1, 2, 3]);
			expect(rowsTop(container)).toBe("-100px");
		});
	});
});

describe("scrollToIndex", () => {
	it("puts the requested row's top at the top of the viewport", () => {
		const { container, component } = mountList(5000);

		component.scrollToIndex(300);

		expect(viewportOf(container).scrollTop).toBe(300 * ROW_HEIGHT);
	});

	it("clamps past the end of the list", () => {
		const { container, component } = mountList(10);

		component.scrollToIndex(999);

		expect(viewportOf(container).scrollTop).toBe(9 * ROW_HEIGHT);
	});
});

describe("revealIndex", () => {
	it("scrolls a row below the viewport up until its bottom edge shows", () => {
		const { container, component } = mountList(5000);

		component.revealIndex(100);

		expect(viewportOf(container).scrollTop).toBe(
			101 * ROW_HEIGHT - VIEWPORT_HEIGHT,
		);
	});

	it("scrolls a row above the viewport down until its top edge shows", () => {
		const { container, component } = mountList(5000);
		component.scrollToIndex(300);

		component.revealIndex(250);

		expect(viewportOf(container).scrollTop).toBe(250 * ROW_HEIGHT);
	});

	it("leaves the scroll alone when the row already shows whole", () => {
		const { container, component } = mountList(5000);
		component.scrollToIndex(300);

		component.revealIndex(303);

		expect(viewportOf(container).scrollTop).toBe(300 * ROW_HEIGHT);
	});
});

describe("anchorTo", () => {
	it("restores a row to the top after every height has changed", async () => {
		const { container, component, rerender } = mountList(5000);
		component.scrollToIndex(300);

		const anchor = component.topIndex();
		await rerender({
			items: Array.from({ length: 5000 }, (_, index) => index),
			heights: Array.from({ length: 5000 }, () => ROW_HEIGHT * 2),
			contentWidth: "1000px",
			renderItem,
		});
		component.anchorTo(anchor);

		expect(viewportOf(container).scrollTop).toBe(300 * ROW_HEIGHT * 2);
	});
});
