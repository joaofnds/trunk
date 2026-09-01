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
});
