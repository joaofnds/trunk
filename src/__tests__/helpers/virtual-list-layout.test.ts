import { afterEach, describe, expect, it } from "vitest";
import {
	restoreVirtualListLayout,
	stubVirtualListLayout,
} from "./virtual-list-layout.js";

describe("the virtual list layout stub", () => {
	afterEach(restoreVirtualListLayout);

	it("puts back the ResizeObserver it replaced", () => {
		const original = globalThis.ResizeObserver;

		stubVirtualListLayout({ viewportHeight: 200 });
		restoreVirtualListLayout();

		expect(globalThis.ResizeObserver).toBe(original);
	});

	it("puts back the layout properties it replaced", () => {
		stubVirtualListLayout({ viewportHeight: 200 });
		restoreVirtualListLayout();

		expect(document.createElement("div").clientHeight).toBe(0);
	});

	/**
	 * The whole reason this module exists. The stub that preceded it answered one
	 * height for every element, so a row measured as tall as the viewport that
	 * held it, one row filled the list, and nothing could scroll — which is how
	 * TRUNK-87 shipped two features that never rendered past 121 goldens.
	 */
	it("measures a row and the viewport that holds it as different heights", () => {
		stubVirtualListLayout({ viewportHeight: 200, rowHeight: 28 });

		const row = document.createElement("div");
		row.setAttribute("data-original-index", "0");
		const viewport = document.createElement("div");
		viewport.className = "virtual-list-viewport";
		document.body.append(row, viewport);

		expect(row.clientHeight).toBe(28);
		expect(viewport.clientHeight).toBe(200);

		row.remove();
		viewport.remove();
	});
});
