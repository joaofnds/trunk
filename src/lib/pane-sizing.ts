export interface PaneSizingOptions {
	/** Which of the pane's edges its splitter sits on, so which way widens it. */
	splitterEdge: "left" | "right";
	/** The narrowest the pane is drawn open: narrower, it collapses. */
	floor: () => number;
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
	/**
	 * Saves the width the user gave the pane: once a resize of it that changed
	 * the width ends, or when a resize of another pane adopts its drawn width.
	 */
	store: (width: number) => void;
}

export interface PaneSizing {
	/** A keyboard step, in the splitter's own direction: positive moves it right. */
	step(delta: number): void;
	startResize(e: MouseEvent): void;
	/**
	 * Takes a width the layout narrowed the open pane to as its own, and stores
	 * it unless the pane is the one being resized, which stores its width once
	 * the resize ends. A pane drawn wider than its width, at its floor, keeps
	 * its width.
	 * Read every pane's drawn width before adopting any: adopting one re-fits
	 * the others.
	 */
	adopt(drawn: number): void;
}

// A pane collapses on the way to narrower than its minimum, so the width it
// last had is one it only passed through. Toggled open, it reopens at the width
// it had when the narrowing began: where the drag took hold, or before the
// first of a run of narrowing steps, which any widening or a change of its
// minimum ends. A drag or a step that widens a collapsed pane opens it at its
// minimum instead, keeping a narrower width the minimum already draws it at.
export function createPaneSizing(options: PaneSizingOptions): PaneSizing {
	const widenSign = options.splitterEdge === "right" ? 1 : -1;
	let steps: { from: number; floor: number } | null = null;
	let resizing = false;

	function size() {
		return options.collapsed() ? 0 : options.drawn();
	}

	function setCollapsed(collapsed: boolean) {
		if (options.collapsed() !== collapsed) options.oncollapsedchange(collapsed);
	}

	/** Reports whether the width collapsed the pane. */
	function resize(width: number): boolean {
		if (width < options.floor()) {
			setCollapsed(true);
			return true;
		}

		setCollapsed(false);
		options.onwidthchange(
			Math.max(options.floor(), Math.min(options.max(), width)),
		);
		return false;
	}

	function openAtFloor() {
		setCollapsed(false);
		if (options.width() > options.floor()) {
			options.onwidthchange(options.floor());
		}
	}

	function adopt(drawn: number) {
		if (options.collapsed() || drawn >= options.width()) return;

		options.onwidthchange(drawn);
		if (!resizing) options.store(drawn);
	}

	/** Adopts every pane's drawn width, and returns this pane's width from before. */
	function beginResize(): number {
		const width = options.width();
		resizing = true;
		options.beforeresize();
		resizing = false;
		return width;
	}

	function storeIfChangedFrom(width: number) {
		if (options.width() !== width) options.store(options.width());
	}

	// A press that moves nothing leaves every width as the user gave it, so the
	// drawn widths are adopted only once the pointer moves the splitter.
	function startResize(e: MouseEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = size();
		let widthBefore = options.width();
		let reopenWidth = widthBefore;
		let moved = false;
		let collapsed = false;
		steps = null;

		function onMouseMove(ev: MouseEvent) {
			if (ev.clientX === startX && !moved) return;
			if (!moved) {
				widthBefore = beginResize();
				reopenWidth = options.width();
			}
			moved = true;
			collapsed = resize(
				Math.max(0, startWidth + widenSign * (ev.clientX - startX)),
			);
		}

		function onMouseUp() {
			if (collapsed) options.onwidthchange(reopenWidth);
			storeIfChangedFrom(widthBefore);
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

		const width = beginResize();

		if (options.collapsed()) {
			steps = null;
			openAtFloor();
		} else {
			stepOpen(change);
		}

		storeIfChangedFrom(width);
	}

	function stepOpen(change: number) {
		const floor = options.floor();
		const from = steps?.floor === floor ? steps.from : options.width();
		steps = change > 0 ? null : { from, floor };

		if (!resize(Math.max(0, size() + change))) return;

		steps = null;
		if (from !== options.width()) options.onwidthchange(from);
	}

	return { step, startResize, adopt };
}

export interface PaneWidths {
	/** The width the user gave the pane. */
	readonly width: number;
	readonly floor: number;
	readonly ceiling: number;
	/** Whether the view draws the pane: not while it is collapsed or the view has none. */
	readonly open: boolean;
}

export interface FittedPane {
	/** The width the layout draws the pane at: none while it is closed. */
	readonly drawn: number;
	/** The widest a resize may take the pane, which leaves the center its floor. */
	readonly max: number;
}

export interface PaneFit {
	readonly left: FittedPane;
	readonly right: FittedPane;
}

export interface PaneLayout {
	/** The width of the row the panes and the center share. */
	readonly rowWidth: number;
	/** The narrowest the center is drawn, the splitters beside it included. */
	readonly centerFloor: number;
	readonly left: PaneWidths;
	readonly right: PaneWidths;
}

export function fitPanes(layout: PaneLayout): PaneFit {
	const drawn = drawnWidths(layout);

	return {
		left: {
			drawn: drawn.left,
			max: maxWidth(layout, layout.left, drawn.right),
		},
		right: {
			drawn: drawn.right,
			max: maxWidth(layout, layout.right, drawn.left),
		},
	};
}

// When the panes and the center's floor do not fit the row, both panes give
// up the same share of what they hold above their floors, so neither reaches
// its floor first. Past their floors the center gives way instead.
function drawnWidths(layout: PaneLayout): { left: number; right: number } {
	const leftFloor = heldFloor(layout.left);
	const rightFloor = heldFloor(layout.right);
	const left = heldWidth(layout.left);
	const right = heldWidth(layout.right);
	const spare = layout.rowWidth - layout.centerFloor - left - right;
	if (spare >= 0) return { left, right };

	const leftAbove = left - leftFloor;
	const rightAbove = right - rightFloor;
	const kept = Math.max(0, 1 + spare / (leftAbove + rightAbove));

	return {
		left: Math.floor(leftFloor + leftAbove * kept),
		right: Math.floor(rightFloor + rightAbove * kept),
	};
}

function heldWidth(pane: PaneWidths): number {
	return pane.open ? Math.max(pane.width, pane.floor) : 0;
}

function heldFloor(pane: PaneWidths): number {
	return pane.open ? pane.floor : 0;
}

// An open pane is drawn at least its floor wide, so a maximum under the floor
// would sit below the value its divider reports.
function maxWidth(
	layout: PaneLayout,
	pane: PaneWidths,
	otherDrawn: number,
): number {
	const room = layout.rowWidth - layout.centerFloor - otherDrawn;
	return Math.max(pane.floor, Math.min(pane.ceiling, room));
}
