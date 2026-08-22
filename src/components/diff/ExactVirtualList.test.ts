import { render } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import ExactVirtualList from "./ExactVirtualList.svelte";

const ROW_HEIGHT = 18;
const VIEWPORT_HEIGHT = 200;

afterEach(restoreLayout);

const renderItem = createRawSnippet<[unknown, number]>(() => ({
	render: () => `<div class="row"></div>`,
}));

function mountList(count: number, rowHeight: number = ROW_HEIGHT) {
	stubLayout({ width: 800, height: VIEWPORT_HEIGHT });

	return render(ExactVirtualList, {
		props: {
			items: Array.from({ length: count }, (_, index) => index),
			heights: Array.from({ length: count }, () => rowHeight),
			contentWidth: "1000px",
			renderItem,
		},
	});
}

function viewportOf(container: Element): HTMLElement {
	return container.querySelector(".exact-virtual-viewport") as HTMLElement;
}

describe("ExactVirtualList", () => {
	it("mounts the rows covering the viewport plus one screen of runway", () => {
		const { container } = mountList(5000);

		expect(container.querySelectorAll(".row").length).toBe(23);
	});

	it("keeps the mounted count independent of the list's length", () => {
		const { container } = mountList(50_000);

		expect(container.querySelectorAll(".row").length).toBeLessThan(200);
	});

	it("sizes the content to the total height of every row", () => {
		const { container } = mountList(5000);

		const content = container.querySelector(".exact-virtual-content");

		expect(content?.getAttribute("style")).toContain(
			`height: ${5000 * ROW_HEIGHT}px`,
		);
	});

	it("stretches the rows container to the full content width", () => {
		const { container } = mountList(5000);

		const rows = container.querySelector(".exact-virtual-rows");

		expect(rows?.getAttribute("style")).toContain("min-width: 100%");
	});

	it("offsets the mounted rows by the first one's top", async () => {
		const { container } = mountList(5000);
		const viewport = viewportOf(container);

		viewport.scrollTop = 100 * ROW_HEIGHT;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();

		const runwayTop = 100 * ROW_HEIGHT - VIEWPORT_HEIGHT;
		const firstRow = Math.floor(runwayTop / ROW_HEIGHT);
		const rows = container.querySelector(".exact-virtual-rows");
		expect(rows?.getAttribute("style")).toContain(
			`translateY(${firstRow * ROW_HEIGHT}px)`,
		);
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
