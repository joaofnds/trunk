import {
	createPaneSizing,
	type FittedPane,
	fitPanes,
	type PaneSizing,
} from "./pane-sizing.js";

const SIDEBAR = { floor: 80, ceiling: 600 };
const REVIEW_LIST_FLOOR = 200;
const DETAIL_PANE = { floor: 200, ceiling: 700 };
// Room for the diff toolbar's compact controls beside a file name.
const CENTER_FLOOR = 400;

/**
 * Which side panes the window draws beside the center: review mode has no
 * detail pane, and the rebase editor no sidebar.
 */
export type SidePaneView = "main" | "review" | "rebase";

/** A side pane's width and collapse, as the user set them and as they are kept. */
export interface SidePane {
	width: () => number;
	collapsed: () => boolean;
	onwidthchange: (width: number) => void;
	oncollapsedchange: (collapsed: boolean) => void;
	store: (width: number) => void;
}

/** A side pane as the layout draws it, with the splitter controls that resize it. */
export interface DrawnPane {
	readonly width: number;
	readonly max: number;
	step(delta: number): void;
	startResize(e: MouseEvent): void;
}

export interface SidePanes {
	/** Attaches to the row the panes and the center share, to fit them to its width. */
	observeRow(row: HTMLElement): () => void;
	readonly sidebar: DrawnPane;
	readonly detailPane: DrawnPane;
	/** The detail pane beside the rebase editor. */
	readonly rebaseDetailPane: DrawnPane;
}

// The main view stays laid out under the rebase editor, so it keeps a fit of
// its own and leaving the editor returns to the panes as they were drawn.
export function createSidePanes(options: {
	view: () => SidePaneView;
	sidebar: SidePane;
	detailPane: SidePane;
}): SidePanes {
	const { sidebar, detailPane } = options;
	// Unmeasured until the observer first reports, so nothing narrows the panes.
	let rowWidth = $state(Number.POSITIVE_INFINITY);

	function sidebarFloor() {
		return options.view() === "review" ? REVIEW_LIST_FLOOR : SIDEBAR.floor;
	}

	function fitShown(shows: { sidebar: boolean; detailPane: boolean }) {
		return fitPanes({
			rowWidth,
			centerFloor: CENTER_FLOOR,
			left: {
				width: sidebar.width(),
				floor: sidebarFloor(),
				ceiling: SIDEBAR.ceiling,
				open: shows.sidebar && !sidebar.collapsed(),
			},
			right: {
				width: detailPane.width(),
				floor: DETAIL_PANE.floor,
				ceiling: DETAIL_PANE.ceiling,
				open: shows.detailPane && !detailPane.collapsed(),
			},
		});
	}

	const mainFit = $derived(
		fitShown({ sidebar: true, detailPane: options.view() !== "review" }),
	);
	const rebaseFit = $derived(fitShown({ sidebar: false, detailPane: true }));
	const shownFit = $derived(options.view() === "rebase" ? rebaseFit : mainFit);

	// Both panes adopt their drawn widths from one fit, read before either
	// adopts, since adopting one re-fits the other.
	function adoptDrawnWidths() {
		const { left, right } = shownFit;
		const view = options.view();

		if (view !== "rebase") sidebarSizing.adopt(left.drawn);
		if (view !== "review") detailSizing.adopt(right.drawn);
	}

	const sidebarSizing = createPaneSizing({
		splitterEdge: "right",
		floor: sidebarFloor,
		max: () => mainFit.left.max,
		width: sidebar.width,
		drawn: () => mainFit.left.drawn,
		collapsed: sidebar.collapsed,
		beforeresize: adoptDrawnWidths,
		onwidthchange: sidebar.onwidthchange,
		oncollapsedchange: sidebar.oncollapsedchange,
		store: sidebar.store,
	});
	const detailSizing = createPaneSizing({
		splitterEdge: "left",
		floor: () => DETAIL_PANE.floor,
		max: () => shownFit.right.max,
		width: detailPane.width,
		drawn: () => shownFit.right.drawn,
		collapsed: detailPane.collapsed,
		beforeresize: adoptDrawnWidths,
		onwidthchange: detailPane.onwidthchange,
		oncollapsedchange: detailPane.oncollapsedchange,
		store: detailPane.store,
	});

	function observeRow(row: HTMLElement) {
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) rowWidth = entry.contentRect.width;
		});
		observer.observe(row);
		return () => observer.disconnect();
	}

	return {
		observeRow,
		sidebar: drawnPane(sidebarSizing, () => mainFit.left),
		detailPane: drawnPane(detailSizing, () => mainFit.right),
		rebaseDetailPane: drawnPane(detailSizing, () => rebaseFit.right),
	};
}

function drawnPane(sizing: PaneSizing, fitted: () => FittedPane): DrawnPane {
	return {
		get width() {
			return fitted().drawn;
		},
		get max() {
			return fitted().max;
		},
		step: sizing.step,
		startResize: sizing.startResize,
	};
}
