import { describe, expect, it } from "vitest";
import {
	CLOSED_PANE,
	createPaneSizing,
	fitPanes,
	type PaneSizing,
} from "./pane-sizing.js";

interface Layout {
	collapsed?: boolean;
	/** The most the room beside the pane allows it. */
	room?: number;
	/** The widest the layout draws the pane, whatever its width. */
	drawnUpTo?: number;
}

function sidebarAt(width: number, layout: Layout = {}) {
	const pane = { width, collapsed: layout.collapsed ?? false };
	const stored: number[] = [];
	const drawn = () =>
		Math.min(pane.width, layout.drawnUpTo ?? Number.POSITIVE_INFINITY);
	const sizing: PaneSizing = createPaneSizing({
		splitterEdge: "right",
		min: 80,
		max: () => Math.min(600, layout.room ?? Number.POSITIVE_INFINITY),
		width: () => pane.width,
		drawn,
		beforeresize: () => sizing.adopt(drawn()),
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
		const { pane, sizing } = sidebarAt(300, { collapsed: true });

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

	it("stops a drag at the most the room beside it allows", () => {
		const { pane, sizing } = sidebarAt(200, { room: 260 });

		sizing.startResize(grab(1000));
		moveTo(1200);

		expect(pane.width).toBe(260);
	});

	it("keeps its floor when the room beside it allows less", () => {
		const { pane, sizing } = sidebarAt(200, { room: 50 });

		sizing.startResize(grab(1000));
		moveTo(1010);

		expect(pane).toEqual({ width: 80, collapsed: false });
	});

	it("starts a drag from the width the layout draws it at", () => {
		const { pane, sizing } = sidebarAt(200, { drawnUpTo: 150 });

		sizing.startResize(grab(1000));
		moveTo(1010);

		expect(pane.width).toBe(160);
	});

	it("steps from the width the layout draws it at", () => {
		const { pane, sizing } = sidebarAt(200, { drawnUpTo: 150 });

		sizing.step(-8);

		expect(pane.width).toBe(142);
	});

	it("keeps the width the user gave it through a press that moves nothing", () => {
		const { pane, stored, sizing } = sidebarAt(200, { drawnUpTo: 150 });

		sizing.startResize(grab(1000));
		release();

		expect(pane.width).toBe(200);
		expect(stored).toEqual([]);
	});

	it("reopens a pane a drag collapsed at the width the layout drew it at", () => {
		const { pane, stored, sizing } = sidebarAt(200, { drawnUpTo: 150 });

		sizing.startResize(grab(1000));
		moveTo(800);
		release();

		expect(pane).toEqual({ width: 150, collapsed: true });
		expect(stored).toEqual([150]);
	});

	it("stores the width the layout draws it at when a resize begins", () => {
		const { stored, sizing } = sidebarAt(200, { drawnUpTo: 150 });

		sizing.step(-8);

		expect(stored[0]).toBe(150);
	});
});

describe("fitPanes", () => {
	it("draws each pane at its width while both fit beside the centre's floor", () => {
		expect(
			fitPanes({
				room: 1280,
				centreFloor: 400,
				left: { width: 220, floor: 80 },
				right: { width: 280, floor: 200 },
			}),
		).toEqual({ left: 220, right: 280 });
	});

	it("narrows both panes in proportion to their width above their floors", () => {
		expect(
			fitPanes({
				room: 830,
				centreFloor: 400,
				left: { width: 280, floor: 80 },
				right: { width: 300, floor: 200 },
			}),
		).toEqual({ left: 180, right: 250 });
	});

	it("draws both panes at their floors when even those leave the centre less than its floor", () => {
		expect(
			fitPanes({
				room: 600,
				centreFloor: 400,
				left: { width: 220, floor: 80 },
				right: { width: 280, floor: 200 },
			}),
		).toEqual({ left: 80, right: 200 });
	});

	it("draws a pane narrower than its floor at its floor", () => {
		expect(
			fitPanes({
				room: 1280,
				centreFloor: 400,
				left: { width: 60, floor: 80 },
				right: { width: 280, floor: 200 },
			}),
		).toEqual({ left: 80, right: 280 });
	});

	it("gives a closed pane's room to the other", () => {
		expect(
			fitPanes({
				room: 900,
				centreFloor: 400,
				left: CLOSED_PANE,
				right: { width: 600, floor: 200 },
			}),
		).toEqual({ left: 0, right: 500 });
	});
});
