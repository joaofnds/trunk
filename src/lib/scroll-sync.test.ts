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

	// A column's scroll event arrives a frame after the sync wrote its offset, by
	// which time the column the offset came from may have moved on.
	it("leaves the source where it is when a mirrored column reports only the offset it was given", () => {
		const sync = createHorizontalScrollSync();
		const a = document.createElement("div");
		const b = document.createElement("div");
		sync(a);
		sync(b);
		a.scrollLeft = 10;
		a.dispatchEvent(new Event("scroll"));
		a.scrollLeft = 20;

		b.dispatchEvent(new Event("scroll"));

		expect(a.scrollLeft).toBe(20);
	});

	it("still follows a mirrored column the user scrolls on", () => {
		const sync = createHorizontalScrollSync();
		const a = document.createElement("div");
		const b = document.createElement("div");
		sync(a);
		sync(b);
		a.scrollLeft = 10;
		a.dispatchEvent(new Event("scroll"));

		b.scrollLeft = 30;
		b.dispatchEvent(new Event("scroll"));

		expect(a.scrollLeft).toBe(30);
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
