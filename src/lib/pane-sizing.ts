export interface PaneSizingOptions {
	/** Which of the pane's edges its splitter sits on, so which way widens it. */
	splitterEdge: "left" | "right";
	/** The narrowest the pane is drawn open: narrower, it collapses. */
	min: number;
	/** The widest the pane may go, which the room beside it can lower. */
	max: () => number;
	/** The width the user gave the pane. */
	width: () => number;
	/** The width the layout draws the open pane at, which the room can narrow. */
	drawn: () => number;
	collapsed: () => boolean;
	/** Runs before a drag or a step first changes a width, so every pane can adopt its drawn width. */
	beforeresize: () => void;
	onwidthchange: (width: number) => void;
	oncollapsedchange: (collapsed: boolean) => void;
	store: (width: number) => void;
}

export interface PaneSizing {
	/** The width the pane takes up: none while it is collapsed. */
	size(): number;
	/** A keyboard step, in the splitter's own direction: positive moves it right. */
	step(delta: number): void;
	startResize(e: MouseEvent): void;
	/**
	 * Takes a width the layout drew the open pane at as its own, and stores it.
	 * Read every pane's drawn width before adopting any: adopting one re-fits
	 * the others.
	 */
	adopt(drawn: number): void;
}

// A pane collapses on the way to narrower than its minimum, so the width it
// last had is one it only passed through. Toggled open, it reopens at the width
// it had when the narrowing began: where the drag took hold, or before the
// first of a run of narrowing steps, which any widening ends. A drag or a step
// that widens a collapsed pane opens it at its minimum instead.
export function createPaneSizing(options: PaneSizingOptions): PaneSizing {
	const widenSign = options.splitterEdge === "right" ? 1 : -1;
	let stepsFrom: number | null = null;

	function size() {
		return options.collapsed() ? 0 : options.drawn();
	}

	/** Reports whether the width collapsed the pane. */
	function resize(width: number): boolean {
		if (width < options.min) {
			options.oncollapsedchange(true);
			return true;
		}

		options.oncollapsedchange(false);
		options.onwidthchange(
			Math.max(options.min, Math.min(options.max(), width)),
		);
		return false;
	}

	function storeOpenWidth() {
		if (!options.collapsed()) options.store(options.width());
	}

	function adopt(drawn: number) {
		if (options.collapsed() || drawn === options.width()) return;

		options.onwidthchange(drawn);
		options.store(drawn);
	}

	// A press that moves nothing leaves every width as the user gave it, so the
	// drawn widths are adopted only once the pointer moves the splitter.
	function startResize(e: MouseEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = size();
		let reopenWidth = options.width();
		let moved = false;
		let collapsed = false;
		stepsFrom = null;

		function onMouseMove(ev: MouseEvent) {
			if (ev.clientX === startX && !moved) return;
			if (!moved) {
				options.beforeresize();
				reopenWidth = options.width();
			}
			moved = true;
			collapsed = resize(
				Math.max(0, startWidth + widenSign * (ev.clientX - startX)),
			);
		}

		function onMouseUp() {
			if (collapsed) options.onwidthchange(reopenWidth);
			if (moved) storeOpenWidth();
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		}

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
	}

	function step(delta: number) {
		const change = widenSign * delta;
		const widens = change > 0;
		if (options.collapsed() && !widens) return;

		options.beforeresize();

		if (options.collapsed()) {
			stepsFrom = null;
			resize(options.min);
			return;
		}

		const from = stepsFrom ?? options.width();
		stepsFrom = widens ? null : from;

		if (!resize(Math.max(0, size() + change))) return;

		stepsFrom = null;
		if (from !== options.width()) options.onwidthchange(from);
	}

	return { size, step, startResize, adopt };
}

export interface PaneRoom {
	width: number;
	floor: number;
}

/** A pane that takes no room: collapsed, or not part of the layout. */
export const CLOSED_PANE: PaneRoom = { width: 0, floor: 0 };

// When the panes and the centre's floor do not fit the room, both panes give
// up the same share of what they hold above their floors, so neither reaches
// its floor first. Past their floors the centre gives way instead.
export function fitPanes(layout: {
	room: number;
	centreFloor: number;
	left: PaneRoom;
	right: PaneRoom;
}): { left: number; right: number } {
	const left = Math.max(layout.left.width, layout.left.floor);
	const right = Math.max(layout.right.width, layout.right.floor);
	const spare = layout.room - layout.centreFloor - left - right;
	if (spare >= 0) return { left, right };

	const leftAbove = left - layout.left.floor;
	const rightAbove = right - layout.right.floor;
	const kept = Math.max(0, 1 + spare / (leftAbove + rightAbove));

	return {
		left: Math.floor(layout.left.floor + leftAbove * kept),
		right: Math.floor(layout.right.floor + rightAbove * kept),
	};
}
