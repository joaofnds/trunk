import { describe, expect, it } from "vitest";
import { createPaneSizing } from "./pane-sizing.js";

function sidebarAt(width: number, collapsed = false) {
	const pane = { width, collapsed };
	const stored: number[] = [];
	const sizing = createPaneSizing({
		splitterEdge: "right",
		min: 80,
		max: 600,
		width: () => pane.width,
		collapsed: () => pane.collapsed,
		onwidthchange: (next) => {
			pane.width = next;
		},
		oncollapsedchange: (next) => {
			pane.collapsed = next;
		},
		store: (next) => stored.push(next),
	});
	return { pane, stored, sizing };
}

function grab(clientX: number) {
	return new MouseEvent("mousedown", { clientX, cancelable: true });
}

function moveTo(clientX: number) {
	window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

function release() {
	window.dispatchEvent(new MouseEvent("mouseup"));
}

describe("createPaneSizing", () => {
	it("collapses on a step below its floor", () => {
		const { pane, sizing } = sidebarAt(88);

		sizing.step(-8);
		sizing.step(-8);

		expect(pane).toEqual({ width: 88, collapsed: true });
	});

	it("opens a collapsed pane at its floor on a widening step", () => {
		const { pane, sizing } = sidebarAt(300, true);

		sizing.step(8);

		expect(pane).toEqual({ width: 80, collapsed: false });
	});

	it("collapses on a drag below its floor", () => {
		const { pane, sizing } = sidebarAt(200);

		sizing.startResize(grab(1000));
		moveTo(879);

		expect(pane.collapsed).toBe(true);
	});

	it("reopens at the width the last run of narrowing steps began at", () => {
		const { pane, sizing } = sidebarAt(90);

		for (const delta of [-8, 8, 8, -8, -8, -8]) sizing.step(delta);

		expect(pane).toEqual({ width: 98, collapsed: true });
	});

	it("starts a new run of narrowing steps after a drag", () => {
		const { pane, sizing } = sidebarAt(200);

		sizing.step(-8);
		sizing.startResize(grab(1000));
		moveTo(898);
		release();
		sizing.step(-8);
		sizing.step(-8);

		expect(pane).toEqual({ width: 90, collapsed: true });
	});

	it("stops following the pointer once the drag is released", () => {
		const { pane, stored, sizing } = sidebarAt(200);

		sizing.startResize(grab(1000));
		moveTo(1040);
		release();
		moveTo(1100);

		expect(pane).toEqual({ width: 240, collapsed: false });
		expect(stored).toEqual([240]);
	});
});
