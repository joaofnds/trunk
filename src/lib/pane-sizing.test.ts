import { describe, expect, it } from "vitest";
import { createPaneSizing } from "./pane-sizing.js";

function sidebarAt(width: number) {
	const pane = { width, collapsed: false };
	const stored: number[] = [];
	const sizing = createPaneSizing({
		splitterEdge: "right",
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
	it("reopens at the width the last run of narrowing steps began at", () => {
		const { pane, sizing } = sidebarAt(60);

		for (const delta of [-8, 8, 8, -8, -8, -8]) sizing.step(delta);

		expect(pane).toEqual({ width: 68, collapsed: true });
	});

	it("starts a new run of narrowing steps after a drag", () => {
		const { pane, sizing } = sidebarAt(200);

		sizing.step(-8);
		sizing.startResize(grab(1000));
		moveTo(868);
		release();
		sizing.step(-8);
		sizing.step(-8);

		expect(pane).toEqual({ width: 60, collapsed: true });
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
