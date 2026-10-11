import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import Sortable, { type SortableEvent } from "sortablejs";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { TabInfo } from "../lib/tab-types.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import TabBar from "./TabBar.svelte";
import "../__tests__/helpers/tauri-mock";

const first: TabInfo = {
	id: "first",
	repoPath: null,
	repoName: "first",
	dirty: false,
};
const second: TabInfo = { ...first, id: "second", repoName: "second" };

function props(tabs: TabInfo[], onreorder = (_tabs: TabInfo[]) => {}) {
	return {
		tabs,
		activeTabId: first.id,
		onactivate: (_id: string) => {},
		onclose: (_id: string, _force: boolean) => {},
		onnew: () => {},
		oncontextmenu: (_id: string, _event: MouseEvent) => {},
		onauxclose: (_id: string) => {},
		onreorder,
	};
}

function tabList(): HTMLElement {
	return screen.getByRole("tablist", { name: "Repository tabs" });
}

async function dragInstance(list: HTMLElement): Promise<Sortable> {
	return waitFor(() => {
		const instance = Sortable.get(list);
		if (!instance) throw new Error("tab dragging is not enabled");
		return instance;
	});
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	_resetToasts();
	vi.restoreAllMocks();
});

function holdDragModule() {
	const request = Promise.withResolvers<{ default: typeof Sortable }>();
	const entered = Promise.withResolvers<void>();
	vi.doMock("sortablejs", () => {
		entered.resolve();
		return request.promise;
	});
	onTestFinished(async () => {
		cleanup();
		request.resolve({ default: Sortable });
		await vi.dynamicImportSettled();
		vi.doUnmock("sortablejs");
	});
	return { request, entered: entered.promise };
}

describe("TabBar", () => {
	it("keeps a single tab undraggable", async () => {
		render(TabBar, { props: props([first]) });

		await tick();
		await vi.dynamicImportSettled();

		expect(Sortable.get(tabList())).toBeFalsy();
	});

	it("enables dragging after a second tab appears", async () => {
		const view = render(TabBar, { props: props([first]) });

		await view.rerender(props([first, second]));

		expect(await dragInstance(tabList())).toBeInstanceOf(Sortable);
	});

	it("keeps its drag instance when the tab order changes", async () => {
		const view = render(TabBar, { props: props([first, second]) });
		const instance = await dragInstance(tabList());

		await view.rerender(props([second, first]));
		await tick();

		expect(Sortable.get(tabList())).toBe(instance);
	});

	it("reorders the tabs as they stand when the drag ends", async () => {
		const orders: TabInfo[][] = [];
		const onreorder = (tabs: TabInfo[]) => orders.push(tabs);
		const view = render(TabBar, { props: props([first, second], onreorder) });
		const instance = await dragInstance(tabList());
		const third = { ...first, id: "third", repoName: "third" };
		await view.rerender(props([first, third, second], onreorder));

		const item = screen.getByRole("tab", { name: "second" });
		const event: SortableEvent = Object.assign(
			Object.defineProperty(new Event("end"), "target", {
				value: item,
				writable: true,
			}),
			{
				target: item,
				from: tabList(),
				to: tabList(),
				item,
				clone: item,
				items: [],
				oldIndex: 2,
				newIndex: 0,
				oldDraggableIndex: 2,
				newDraggableIndex: 0,
				pullMode: undefined,
				oldIndicies: [],
				newIndicies: [],
				swapItem: null,
			},
		);
		instance.option("onEnd")?.(event);

		expect(orders).toEqual([[second, first, third]]);
	});

	it("removes dragging when only one tab remains", async () => {
		const view = render(TabBar, { props: props([first, second]) });
		await dragInstance(tabList());

		await view.rerender(props([first]));
		await tick();

		expect(Sortable.get(tabList())).toBeFalsy();
	});

	it("removes dragging when the bar unmounts", async () => {
		const view = render(TabBar, { props: props([first, second]) });
		const list = tabList();
		await dragInstance(list);

		view.unmount();

		expect(Sortable.get(list)).toBeFalsy();
	});

	it("keeps one tab undraggable when a second tab closes during loading", async () => {
		const loader = holdDragModule();
		const view = render(TabBar, { props: props([first, second]) });
		const list = tabList();
		onTestFinished(() => Sortable.get(list)?.destroy());

		await loader.entered;
		await view.rerender(props([first]));
		loader.request.resolve({ default: Sortable });
		await vi.dynamicImportSettled();

		expect(Sortable.get(list)).toBeFalsy();
	});

	it("reports a failed drag-module load while tabs remain usable", async () => {
		const loader = holdDragModule();
		const failure = new Error("drag chunk unavailable");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		render(TabBar, { props: props([first, second]) });
		await loader.entered;

		loader.request.reject(failure);
		await vi.dynamicImportSettled();

		expect(toasts.items).toContainEqual(
			expect.objectContaining({
				message: "Could not enable tab reordering",
				kind: "error",
			}),
		);
		expect(log).toHaveBeenCalledWith(
			"Could not enable tab reordering",
			expect.objectContaining({ cause: failure }),
		);
		expect(Sortable.get(tabList())).toBeFalsy();
		expect(screen.getByRole("tab", { name: "first" })).toBeEnabled();
		expect(screen.getByRole("tab", { name: "second" })).toBeEnabled();
	});

	it("ignores a drag-module failure after only one tab remains", async () => {
		const loader = holdDragModule();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const view = render(TabBar, { props: props([first, second]) });
		await loader.entered;
		await view.rerender(props([first]));

		loader.request.reject(new Error("drag chunk unavailable"));
		await vi.dynamicImportSettled();

		expect(toasts.items).toEqual([]);
		expect(log).not.toHaveBeenCalled();
	});
});
