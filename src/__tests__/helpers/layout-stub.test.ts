import { afterEach, describe, expect, it } from "vitest";
import { restoreLayout, stubLayout } from "./layout-stub.js";

describe("the layout stub", () => {
	afterEach(() => {
		// Unwind whatever a failing test left installed, however deep.
		for (let i = 0; i < 8; i++) restoreLayout();
	});

	it("reports the box it was given", () => {
		stubLayout({ height: 4000 });

		expect(document.createElement("div").clientHeight).toBe(4000);
	});

	it("puts the prototypes back when its last caller restores", () => {
		stubLayout({ height: 4000 });
		restoreLayout();

		expect(document.createElement("div").clientHeight).toBe(0);
	});

	/**
	 * Two helpers stub the layout in one test file, and the inner one finishing
	 * must not tear the outer one's stubs off the prototype.
	 *
	 * `graph-render.ts` installs at module load and never restores: it holds the
	 * 4000px viewport all 121 render goldens are pinned to. A suite that also uses
	 * a layout-stub consumer of its own used to strip that on its own teardown,
	 * collapsing the viewport to 0. The goldens then truncate to 22 rows and go
	 * red for a reason that is not a defect in the graph — which the commit-graph
	 * rules say to treat as one (TRUNK-52).
	 */
	/**
	 * Several suites call `stubLayout` again mid-test to widen the box, with a
	 * single `afterEach(restoreLayout)`. That is one holder changing its mind, not
	 * a second one arriving: if every call took a new frame, the extra frames
	 * would never be popped and the stubs would outlive the file that installed
	 * them.
	 */
	it("replaces the box when the same caller re-stubs, and still restores once", () => {
		stubLayout({ height: 400 });
		stubLayout({ height: 900, replace: true });

		expect(document.createElement("div").clientHeight).toBe(900);

		restoreLayout();

		expect(document.createElement("div").clientHeight).toBe(0);
	});

	/**
	 * The counterpart to the nesting test: a frame taken and never popped keeps
	 * the stubs on the prototypes after the suite that installed them is done,
	 * which is the leak `replace` exists to prevent.
	 */
	it("leaves nothing installed when a re-stubbing caller restores once", () => {
		stubLayout({ height: 400 });
		stubLayout({ height: 111, replace: true });
		stubLayout({ height: 222, replace: true });
		restoreLayout();

		expect(document.createElement("div").clientHeight).toBe(0);
	});

	it("keeps an outer caller's box when an inner caller restores", () => {
		stubLayout({ height: 4000 });

		stubLayout({ height: 500 });
		restoreLayout();

		expect(document.createElement("div").clientHeight).toBe(4000);
	});
});
