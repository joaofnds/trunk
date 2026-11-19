export interface PaneSizingOptions {
	/** Which of the pane's edges its splitter sits on, so which way widens it. */
	splitterEdge: "left" | "right";
	/** The narrowest the pane is drawn open: narrower, it collapses. */
	min: number;
	max: number;
	width: () => number;
	collapsed: () => boolean;
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
		return options.collapsed() ? 0 : options.width();
	}

	/** Reports whether the width collapsed the pane. */
	function resize(width: number): boolean {
		if (width < options.min) {
			options.oncollapsedchange(true);
			return true;
		}

		options.oncollapsedchange(false);
		options.onwidthchange(Math.min(options.max, width));
		return false;
	}

	function storeOpenWidth() {
		if (!options.collapsed()) options.store(options.width());
	}

	function startResize(e: MouseEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = size();
		const reopenWidth = options.width();
		let collapsed = false;
		stepsFrom = null;

		function onMouseMove(ev: MouseEvent) {
			collapsed = resize(
				Math.max(0, startWidth + widenSign * (ev.clientX - startX)),
			);
		}

		function onMouseUp() {
			if (collapsed) options.onwidthchange(reopenWidth);
			storeOpenWidth();
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

	return { size, step, startResize };
}
