import { render } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import ExactVirtualList from "./ExactVirtualList.svelte";

const ROW_HEIGHT = 18;
const VIEWPORT_HEIGHT = 200;

afterEach(restoreLayout);

const renderItem = createRawSnippet<[number, number]>(() => ({
	render: () => `<div class="row"></div>`,
}));

function mountList(count: number) {
	stubLayout({ width: 800, height: VIEWPORT_HEIGHT });

	return render(ExactVirtualList, {
		props: {
			items: Array.from({ length: count }, (_, index) => index),
			heights: Array.from({ length: count }, () => ROW_HEIGHT),
			contentWidth: "1000px",
			renderItem,
		},
	});
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

	it("offsets the mounted rows by the first one's top", async () => {
		const { container } = mountList(5000);
		const viewport = container.querySelector(
			".exact-virtual-viewport",
		) as HTMLElement;

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
