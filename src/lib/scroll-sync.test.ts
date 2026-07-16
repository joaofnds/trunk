import { describe, expect, it } from "vitest";
import { createHorizontalScrollSync } from "./scroll-sync.js";

describe("createHorizontalScrollSync", () => {
	it("mirrors one column's scrollLeft to every other registered column", () => {
		const sync = createHorizontalScrollSync();
		const a = document.createElement("div");
		const b = document.createElement("div");
		const c = document.createElement("div");
		sync(a);
		sync(b);
		sync(c);

		a.scrollLeft = 42;
		a.dispatchEvent(new Event("scroll"));

		expect(b.scrollLeft).toBe(42);
		expect(c.scrollLeft).toBe(42);
	});

	it("stops mirroring a destroyed column and never scrolls it again", () => {
		const sync = createHorizontalScrollSync();
		const a = document.createElement("div");
		const b = document.createElement("div");
		sync(a);
		const registration = sync(b);

		registration.destroy();
		a.scrollLeft = 10;
		a.dispatchEvent(new Event("scroll"));

		expect(b.scrollLeft).toBe(0);
	});

	it("keeps instances isolated: columns of one sync never move another's", () => {
		const syncA = createHorizontalScrollSync();
		const syncB = createHorizontalScrollSync();
		const a = document.createElement("div");
		const b = document.createElement("div");
		syncA(a);
		syncB(b);

		a.scrollLeft = 7;
		a.dispatchEvent(new Event("scroll"));

		expect(b.scrollLeft).toBe(0);
	});
});
