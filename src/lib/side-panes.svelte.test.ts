import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportWidthOf } from "../__tests__/helpers/fake-resize-observer.js";
import { createSidePanes, type SidePaneView } from "./side-panes.svelte.js";

interface Panes {
	view: SidePaneView;
	rowWidth: number;
	sidebarWidth: number;
	detailPaneWidth: number;
}

async function sidePanesIn(panes: Panes) {
	const row = document.createElement("main");
	reportWidthOf((target) => target === row, panes.rowWidth);
	const set = $state({
		sidebar: { width: panes.sidebarWidth, collapsed: false },
		detailPane: { width: panes.detailPaneWidth, collapsed: false },
	});
	const pane = (side: "sidebar" | "detailPane") => ({
		width: () => set[side].width,
		collapsed: () => set[side].collapsed,
		onwidthchange: (width: number) => {
			set[side].width = width;
		},
		oncollapsedchange: (collapsed: boolean) => {
			set[side].collapsed = collapsed;
		},
		store: () => {},
	});
	const shown = $state({ view: panes.view });
	const sidePanes = createSidePanes({
		view: () => shown.view,
		sidebar: pane("sidebar"),
		detailPane: pane("detailPane"),
	});

	sidePanes.observeRow(row);
	await tick();
	return {
		set,
		sidePanes,
		show: (view: SidePaneView) => {
			shown.view = view;
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createSidePanes", () => {
	it("gives the sidebar the detail pane's room in review mode", async () => {
		const { sidePanes } = await sidePanesIn({
			view: "review",
			rowWidth: 1000,
			sidebarWidth: 220,
			detailPaneWidth: 300,
		});

		expect(sidePanes.sidebar.max).toBe(600);
	});

	it("gives the detail pane the sidebar's room beside the rebase editor", async () => {
		const { sidePanes } = await sidePanesIn({
			view: "rebase",
			rowWidth: 900,
			sidebarWidth: 300,
			detailPaneWidth: 600,
		});

		expect(sidePanes.rebaseDetailPane).toMatchObject({ width: 500, max: 500 });
	});

	it("keeps the main view's panes as drawn under the rebase editor", async () => {
		const { sidePanes } = await sidePanesIn({
			view: "rebase",
			rowWidth: 1000,
			sidebarWidth: 300,
			detailPaneWidth: 600,
		});

		expect([sidePanes.sidebar.width, sidePanes.detailPane.width]).toEqual([
			193, 406,
		]);
	});

	it("keeps the sidebar's width through a step of the detail pane beside the rebase editor", async () => {
		const { set, sidePanes } = await sidePanesIn({
			view: "rebase",
			rowWidth: 900,
			sidebarWidth: 300,
			detailPaneWidth: 600,
		});

		sidePanes.rebaseDetailPane.step(8);

		expect([set.sidebar.width, set.detailPane.width]).toEqual([300, 492]);
	});

	it("keeps the detail pane's width through a step of the sidebar in review mode", async () => {
		const { set, sidePanes } = await sidePanesIn({
			view: "review",
			rowWidth: 700,
			sidebarWidth: 400,
			detailPaneWidth: 300,
		});

		sidePanes.sidebar.step(-8);

		expect([set.sidebar.width, set.detailPane.width]).toEqual([292, 300]);
	});

	describe("while the sidebar holds the review list", () => {
		it("draws the sidebar no narrower than the review list's floor", async () => {
			const { sidePanes } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 100,
				detailPaneWidth: 300,
			});

			expect(sidePanes.sidebar.width).toBe(200);
		});

		it("collapses the sidebar on a step below the review list's floor", async () => {
			const { set, sidePanes } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 200,
				detailPaneWidth: 300,
			});

			sidePanes.sidebar.step(-8);

			expect(set.sidebar.collapsed).toBe(true);
		});

		it("collapses the sidebar on a step below the review list's floor once review mode begins", async () => {
			const { set, sidePanes, show } = await sidePanesIn({
				view: "main",
				rowWidth: 1280,
				sidebarWidth: 200,
				detailPaneWidth: 300,
			});

			show("review");
			sidePanes.sidebar.step(-8);

			expect(set.sidebar.collapsed).toBe(true);
		});

		it("keeps the narrower width the user gave the sidebar through a step that collapses it", async () => {
			const { set, sidePanes } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 100,
				detailPaneWidth: 300,
			});

			sidePanes.sidebar.step(-8);

			expect(set.sidebar).toEqual({ width: 100, collapsed: true });
		});

		it("keeps the narrower width the user gave the sidebar through a drag that collapses it", async () => {
			const { set, sidePanes } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 100,
				detailPaneWidth: 300,
			});

			sidePanes.sidebar.startResize(
				new MouseEvent("mousedown", { clientX: 200, cancelable: true }),
			);
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150 }));
			window.dispatchEvent(new MouseEvent("mouseup"));

			expect(set.sidebar).toEqual({ width: 100, collapsed: true });
		});

		it("keeps the narrower width the user gave the sidebar through a step that reopens it", async () => {
			const { set, sidePanes } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 100,
				detailPaneWidth: 300,
			});
			sidePanes.sidebar.step(-8);

			sidePanes.sidebar.step(8);

			expect([set.sidebar, sidePanes.sidebar.width]).toEqual([
				{ width: 100, collapsed: false },
				200,
			]);
		});

		it("keeps the width the steps before review mode left the sidebar at when a step collapses it", async () => {
			const { set, sidePanes, show } = await sidePanesIn({
				view: "main",
				rowWidth: 1280,
				sidebarWidth: 208,
				detailPaneWidth: 300,
			});
			for (let i = 0; i < 13; i++) sidePanes.sidebar.step(-8);
			show("review");

			sidePanes.sidebar.step(-8);

			expect(set.sidebar).toEqual({ width: 104, collapsed: true });
		});
	});

	describe("when review mode ends", () => {
		it("draws the sidebar at the width the user gave it", async () => {
			const { sidePanes, show } = await sidePanesIn({
				view: "review",
				rowWidth: 1280,
				sidebarWidth: 100,
				detailPaneWidth: 300,
			});

			show("main");

			expect(sidePanes.sidebar.width).toBe(100);
		});
	});
});
