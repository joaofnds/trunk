import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { FakeIntersectionObserver } from "../__tests__/helpers/fake-intersection-observer.js";
import { reportWidthOf } from "../__tests__/helpers/fake-resize-observer.js";
import { THUMB_CLASS, trackScrollActivity } from "../lib/scrollbar-activity.js";
import type { TabInfo } from "../lib/tab-types.js";
import TabBar from "./TabBar.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

// Mock sortablejs — SortableJS manipulates DOM directly, not testable in jsdom
// TabBar imports `Sortable` as default and calls `Sortable.create()`
vi.mock("sortablejs", () => {
	const sortableInstance = { destroy: vi.fn() };
	const SortableMock = Object.assign(
		vi.fn().mockImplementation(() => sortableInstance),
		{ create: vi.fn().mockReturnValue(sortableInstance) },
	);
	return { default: SortableMock };
});

// jsdom does not implement scrollIntoView — stub it globally
beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const tabs: TabInfo[] = [
	{ id: "1", repoPath: "/path/to/trunk", repoName: "trunk", dirty: false },
	{ id: "2", repoPath: "/path/to/other", repoName: "other", dirty: true },
];

function itemOf(name: string): HTMLElement {
	const item = screen
		.getByRole("tab", { name })
		.closest<HTMLElement>(".tab-item");
	if (!item) throw new Error(`no tab item around the tab named ${name}`);

	return item;
}

function closeOf(name: string): HTMLElement {
	return within(itemOf(name)).getByLabelText("Close tab");
}

/** Shows a tab item to the strip as a scroll would leave it. */
const SHOW = {
	whole: (item: Element) => FakeIntersectionObserver.enter(item),
	cut: (item: Element) => FakeIntersectionObserver.reveal(item, 0.4),
	out: (item: Element) => FakeIntersectionObserver.leave(item),
};

function fadedEdgesOf(strip: HTMLElement): [boolean, boolean] {
	return [
		strip.classList.contains("fades-start"),
		strip.classList.contains("fades-end"),
	];
}

function auxClick(button: number): MouseEvent {
	return new MouseEvent("auxclick", {
		button,
		bubbles: true,
		cancelable: true,
	});
}

describe("TabBar", () => {
	const defaultProps = {
		tabs,
		activeTabId: "1",
		onactivate: vi.fn(),
		onclose: vi.fn(),
		onnew: vi.fn(),
		oncontextmenu: vi.fn(),
		onauxclose: vi.fn(),
		onreorder: vi.fn(),
	};

	it("renders tab names", () => {
		render(TabBar, { props: defaultProps });
		expect(screen.getByText("trunk")).toBeInTheDocument();
		expect(screen.getByText("other")).toBeInTheDocument();
	});

	it("shows the shortest parent context that distinguishes each same-name tab", async () => {
		const paths = [
			"/services/api",
			"/work/services/api",
			"/personal/services/api",
			"/build/api",
		];
		const view = render(TabBar, {
			props: {
				...defaultProps,
				tabs: paths.map((repoPath) => ({
					...tabs[0],
					id: repoPath,
					repoName: "api",
					repoPath,
				})),
			},
		});

		expect(
			screen
				.getAllByRole("tab")
				.map((tab) => tab.textContent?.trim().replace(/\s+/g, " ")),
		).toEqual([
			"api /services",
			"api work/services",
			"api personal/services",
			"api build",
		]);
		expect(screen.getAllByRole("tab")[1]).toHaveAccessibleName(
			/\/work\/services\/api/,
		);

		await view.rerender({ tabs: [{ ...tabs[0], repoName: "api" }] });
		expect(screen.getByRole("tab")).toHaveTextContent(/^api$/);
	});

	it("keeps the difference visible when checkout names and their shared parents are long", () => {
		const name = "server-components-development";
		const repos = ["production", "prototype"].map((environment) => {
			const root = `continuous-integration-environment-${environment}`;
			const path = `/${root}/shared-organization-services/${name}`;
			return { ...tabs[0], id: path, repoPath: path, repoName: name };
		});
		render(TabBar, { props: { ...defaultProps, tabs: repos } });

		for (const [i, environment] of ["production", "prototype"].entries()) {
			const tab = screen.getByRole("tab", {
				name: `${name}, ${repos[i].repoPath}`,
			});
			expect(within(tab).getByText(`…${environment}`)).toBeVisible();
		}
	});

	it("distinguishes Windows checkouts by the drive or shared folder", () => {
		const repos = ["C:\\src\\api", "D:\\src\\api", "\\\\build\\team\\api"].map(
			(repoPath) => ({ ...tabs[0], id: repoPath, repoPath, repoName: "api" }),
		);
		render(TabBar, { props: { ...defaultProps, tabs: repos } });

		const labels = screen
			.getAllByRole("tab")
			.map((tab) => tab.textContent?.trim());
		expect(labels).toEqual(["api C:\\src", "api D:\\src", "api team"]);
	});

	it("keeps an uninterrupted checkout ancestor compact with its distinguishing letter visible", () => {
		const repos = ["X", "Y"].map((letter) => {
			const repoPath = `/${"a".repeat(160)}${letter}${"z".repeat(30)}/api`;
			return { ...tabs[0], id: repoPath, repoName: "api", repoPath };
		});
		render(TabBar, { props: { ...defaultProps, tabs: repos } });
		for (const [i, letter] of ["X", "Y"].entries()) {
			const tab = screen.getByRole("tab", {
				name: `api, ${repos[i].repoPath}`,
			});
			const ancestor = within(tab).getByText(new RegExp(letter));
			expect(ancestor.textContent?.length).toBeLessThanOrEqual(18);
		}
	});

	it("keeps four long checkout names distinct when the same endings recur", () => {
		const roots = ["aaaaaaaaaa", "bbbbbbbbbb"].flatMap((prefix) =>
			["X", "Y"].map((suffix) => `${prefix}SharedDirectoryWithSuffix${suffix}`),
		);
		const repos = roots.map((root) => ({
			...tabs[0],
			id: root,
			repoPath: `/${root}/api`,
			repoName: "api",
		}));
		render(TabBar, { props: { ...defaultProps, tabs: repos } });
		const labels = screen
			.getAllByRole("tab")
			.map((tab) => tab.textContent?.trim());
		expect(new Set(labels).size).toBe(4);
	});

	it("highlights active tab", () => {
		render(TabBar, { props: defaultProps });
		const activeTab = screen.getByText("trunk").closest(".tab-item");
		expect(activeTab?.classList.contains("active")).toBe(true);

		const inactiveTab = screen.getByText("other").closest(".tab-item");
		expect(inactiveTab?.classList.contains("active")).toBe(false);
	});

	it("renders new tab button", () => {
		render(TabBar, { props: defaultProps });
		expect(screen.getByLabelText("New tab")).toBeInTheDocument();
	});

	it("draws the close and new-tab controls as ghost icon buttons", () => {
		render(TabBar, { props: defaultProps });

		expect(screen.getAllByLabelText("Close tab")[0]).toHaveClass(
			"w-control-xs",
			"bg-transparent",
		);
		expect(screen.getByLabelText("New tab")).toHaveClass(
			"w-control",
			"bg-transparent",
		);
	});

	it("frames the new-tab control with a dashed outline", () => {
		render(TabBar, { props: defaultProps });

		expect(screen.getByLabelText("New tab").parentElement).toHaveClass(
			"outline-dashed",
		);
	});

	it("calls onactivate when tab clicked", async () => {
		const onactivate = vi.fn();
		render(TabBar, {
			props: { ...defaultProps, onactivate },
		});
		// Mousedown on the inactive tab (role="tab") — TabBar uses onmousedown, not onclick
		const otherTab = screen.getByText("other").closest('[role="tab"]');
		expect(otherTab).toBeTruthy();
		await fireEvent.mouseDown(otherTab as Element, { button: 0 });
		expect(onactivate).toHaveBeenCalledWith("2");
	});

	it("calls onclose when tab close button clicked", async () => {
		const onclose = vi.fn();
		render(TabBar, {
			props: { ...defaultProps, onclose },
		});
		// Close buttons have aria-label "Close tab"
		const closeBtns = screen.getAllByLabelText("Close tab");
		await fireEvent.click(closeBtns[0]);
		expect(onclose).toHaveBeenCalledWith("1", false);
	});

	it("calls onnew when new tab button clicked", async () => {
		const onnew = vi.fn();
		render(TabBar, {
			props: { ...defaultProps, onnew },
		});
		await fireEvent.click(screen.getByLabelText("New tab"));
		expect(onnew).toHaveBeenCalledOnce();
	});

	it("renders dirty dot for dirty tabs", () => {
		const { container } = render(TabBar, { props: defaultProps });
		// "other" tab is dirty, should have a dirty-dot element
		const dirtyDots = container.querySelectorAll(".dirty-dot");
		expect(dirtyDots.length).toBe(1);
	});

	it("marks active tab with aria-selected", () => {
		render(TabBar, { props: defaultProps });
		const activeTabs = screen.getAllByRole("tab");
		const activeTab = activeTabs.find(
			(t) => t.getAttribute("aria-selected") === "true",
		);
		expect(activeTab).toBeTruthy();
		expect(activeTab?.textContent).toContain("trunk");
	});

	it("is a tablist of tab buttons", () => {
		render(TabBar, { props: defaultProps });

		const tabs = within(
			screen.getByRole("tablist", { name: "Repository tabs" }),
		).getAllByRole("tab");

		expect(tabs.map((tab) => tab.tagName)).toEqual(["BUTTON", "BUTTON"]);
	});

	it("keeps each close beside its tab, not inside it", () => {
		render(TabBar, { props: defaultProps });

		const tab = screen.getByRole("tab", { name: "trunk" });

		expect(within(tab).queryByLabelText("Close tab")).toBeNull();
	});

	it("puts each tab in the Tab order", () => {
		render(TabBar, { props: defaultProps });

		expect(
			screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex")),
		).toEqual(["0", "0"]);
	});

	it.each([
		{
			source: "its repository's path",
			repoPath: "/path/to/lone",
			repoName: "lone",
			name: "lone",
			title: "/path/to/lone",
		},
		{
			source: "its name where it has no repository",
			repoPath: null,
			repoName: "orphan",
			name: "orphan",
			title: "orphan",
		},
		{
			source: '"New Tab" where it has neither',
			repoPath: null,
			repoName: "",
			name: "New Tab",
			title: "New Tab",
		},
	])("titles a tab with $source", ({ repoPath, repoName, name, title }) => {
		render(TabBar, {
			props: {
				...defaultProps,
				tabs: [{ id: "3", repoPath, repoName, dirty: false }],
			},
		});

		expect(screen.getByRole("tab", { name })).toHaveAttribute("title", title);
	});

	it("turns pointer events back on for nothing inside a tab item", () => {
		const { container } = render(TabBar, { props: defaultProps });

		expect(
			container.querySelectorAll('.tab-item [class*="pointer-events-auto"]'),
		).toHaveLength(0);
	});

	it.each(["Enter", " "])("activates a focused tab on %j", async (key) => {
		const activated: string[] = [];
		render(TabBar, {
			props: { ...defaultProps, onactivate: (id) => activated.push(id) },
		});

		await fireEvent.keyDown(screen.getByRole("tab", { name: "other" }), {
			key,
		});

		expect(activated).toEqual(["2"]);
	});

	it.each(["a", "Tab", "Escape", "ArrowRight"])(
		"leaves a focused tab alone on %j",
		async (key) => {
			const activated: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, onactivate: (id) => activated.push(id) },
			});

			await fireEvent.keyDown(screen.getByRole("tab", { name: "other" }), {
				key,
			});

			expect(activated).toEqual([]);
		},
	);

	it.each([1, 2])(
		"leaves a tab alone on a mousedown of button %i",
		async (button) => {
			const activated: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, onactivate: (id) => activated.push(id) },
			});

			await fireEvent.mouseDown(screen.getByRole("tab", { name: "other" }), {
				button,
			});

			expect(activated).toEqual([]);
		},
	);

	it("opens a tab's menu on a right click", async () => {
		const menus: string[] = [];
		render(TabBar, {
			props: { ...defaultProps, oncontextmenu: (id) => menus.push(id) },
		});

		await fireEvent.contextMenu(screen.getByRole("tab", { name: "other" }));

		expect(menus).toEqual(["2"]);
	});

	it("keeps the webview's own menu off a right click on a tab", async () => {
		render(TabBar, { props: defaultProps });

		const unhandled = await fireEvent.contextMenu(
			screen.getByRole("tab", { name: "other" }),
		);

		expect(unhandled).toBe(false);
	});

	it("closes a tab on a middle click", async () => {
		const closed: string[] = [];
		render(TabBar, {
			props: { ...defaultProps, onauxclose: (id) => closed.push(id) },
		});

		await fireEvent(screen.getByRole("tab", { name: "other" }), auxClick(1));

		expect(closed).toEqual(["2"]);
	});

	it("keeps the webview's default off a middle click on a tab", async () => {
		render(TabBar, { props: defaultProps });

		const unhandled = await fireEvent(
			screen.getByRole("tab", { name: "other" }),
			auxClick(1),
		);

		expect(unhandled).toBe(false);
	});

	it("keeps a tab open on an auxiliary click of the right button", async () => {
		const closed: string[] = [];
		render(TabBar, {
			props: { ...defaultProps, onauxclose: (id) => closed.push(id) },
		});

		await fireEvent(screen.getByRole("tab", { name: "other" }), auxClick(2));

		expect(closed).toEqual([]);
	});

	it("keeps the new-tab button out of the tablist", () => {
		render(TabBar, { props: defaultProps });

		const tablist = screen.getByRole("tablist", { name: "Repository tabs" });

		expect(tablist).not.toContainElement(screen.getByLabelText("New tab"));
	});

	it("scrolls the strip sideways on a vertical wheel", async () => {
		render(TabBar, { props: defaultProps });
		const tablist = screen.getByRole("tablist", { name: "Repository tabs" });
		tablist.scrollLeft = 100;

		await fireEvent.wheel(tablist, { deltaX: 2, deltaY: 40 });

		expect(tablist.scrollLeft).toBe(140);
	});

	it("leaves a sideways wheel to the strip's own scrolling", async () => {
		render(TabBar, { props: defaultProps });
		const tablist = screen.getByRole("tablist", { name: "Repository tabs" });

		const unhandled = await fireEvent.wheel(tablist, {
			deltaX: 40,
			deltaY: 30,
		});

		expect([unhandled, tablist.scrollLeft]).toEqual([true, 0]);
	});

	it("paints no scrollbar thumb over the tabs as the strip scrolls", () => {
		onTestFinished(trackScrollActivity());
		render(TabBar, { props: defaultProps });
		const tablist = screen.getByRole("tablist", { name: "Repository tabs" });
		Object.defineProperty(tablist, "scrollWidth", { value: 1000 });
		Object.defineProperty(tablist, "clientWidth", { value: 200 });

		tablist.scrollLeft = 100;
		tablist.dispatchEvent(new Event("scroll"));

		expect(document.querySelector(`.${THUMB_CLASS}`)).toBeNull();
	});

	it("offers no close on a tab the strip's edge cuts", async () => {
		render(TabBar, { props: defaultProps });
		await Promise.resolve();

		FakeIntersectionObserver.reveal(itemOf("other"), 0.4);
		await tick();

		expect(within(itemOf("other")).queryByLabelText("Close tab")).toBeNull();
	});

	it("gives a cut tab its close back once it scrolls whole", async () => {
		render(TabBar, { props: defaultProps });
		await Promise.resolve();
		SHOW.cut(itemOf("other"));
		await tick();

		SHOW.whole(itemOf("other"));
		await tick();

		expect(closeOf("other")).toBeInTheDocument();
	});

	it.each([
		{ first: "whole", last: "whole", fades: [false, false] },
		{ first: "cut", last: "whole", fades: [true, false] },
		{ first: "out", last: "cut", fades: [true, true] },
		{ first: "whole", last: "out", fades: [false, true] },
	] as const)(
		"fades each edge whose end tab is not whole, with the first $first and the last $last",
		async ({ first, last, fades }) => {
			render(TabBar, { props: defaultProps });
			await Promise.resolve();

			SHOW[first](itemOf("trunk"));
			SHOW[last](itemOf("other"));
			await tick();

			const tablist = screen.getByRole("tablist", { name: "Repository tabs" });
			expect(fadedEdgesOf(tablist)).toEqual(fades);
		},
	);

	it("stops fading the end once its cut tab closes", async () => {
		const view = render(TabBar, { props: defaultProps });
		await Promise.resolve();
		SHOW.whole(itemOf("trunk"));
		SHOW.cut(itemOf("other"));
		await tick();

		await view.rerender({ ...defaultProps, tabs: tabs.slice(0, 1) });

		const tablist = screen.getByRole("tablist", { name: "Repository tabs" });
		expect(fadedEdgesOf(tablist)).toEqual([false, false]);
	});

	it("brings the active tab into view when another tab becomes active", async () => {
		const view = render(TabBar, { props: defaultProps });
		const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
		scrollIntoView.mockClear();

		await view.rerender({ ...defaultProps, activeTabId: "2" });

		expect(scrollIntoView.mock.contexts).toEqual([itemOf("other")]);
	});

	it("brings the active tab into view when the strip narrows", async () => {
		const strip = reportWidthOf(
			(target) => target.getAttribute("role") === "tablist",
			600,
		);
		render(TabBar, { props: { ...defaultProps, activeTabId: "2" } });
		await Promise.resolve();
		const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
		scrollIntoView.mockClear();

		strip.resize(300);

		expect(scrollIntoView.mock.contexts).toEqual([itemOf("other")]);
	});

	it("brings the active tab into view when it widens", async () => {
		const activeItem = reportWidthOf(
			(target) => target.matches(".tab-item.active"),
			80,
		);
		render(TabBar, { props: { ...defaultProps, activeTabId: "2" } });
		await Promise.resolve();
		const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
		scrollIntoView.mockClear();

		activeItem.resize(140);

		expect(scrollIntoView.mock.contexts).toEqual([itemOf("other")]);
	});

	describe("on a tab's close", () => {
		it("activates the tab on mousedown, as anywhere else on it", async () => {
			const activated: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, onactivate: (id) => activated.push(id) },
			});

			await fireEvent.mouseDown(closeOf("other"), { button: 0 });

			expect(activated).toEqual(["2"]);
		});

		it.each([1, 2])(
			"leaves the tab alone on a mousedown of button %i",
			async (button) => {
				const activated: string[] = [];
				render(TabBar, {
					props: { ...defaultProps, onactivate: (id) => activated.push(id) },
				});

				await fireEvent.mouseDown(closeOf("other"), { button });

				expect(activated).toEqual([]);
			},
		);

		it.each([0, 1, 2])(
			"moves the focus to its tab on a mousedown of button %i",
			async (button) => {
				render(TabBar, { props: defaultProps });

				const unhandled = await fireEvent.mouseDown(closeOf("other"), {
					button,
				});

				expect(unhandled).toBe(false);
				expect(screen.getByRole("tab", { name: "other" })).toHaveFocus();
			},
		);

		it("asks for no focus ring on the tab its press focuses", async () => {
			render(TabBar, { props: defaultProps });
			const asked: (FocusOptions | undefined)[] = [];
			screen.getByRole("tab", { name: "other" }).focus = (options) => {
				asked.push(options);
			};

			await fireEvent.mouseDown(closeOf("other"), { button: 0 });

			expect(asked).toEqual([expect.objectContaining({ focusVisible: false })]);
		});

		it("opens the tab's menu on a right click", async () => {
			const menus: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, oncontextmenu: (id) => menus.push(id) },
			});

			await fireEvent.contextMenu(closeOf("other"));

			expect(menus).toEqual(["2"]);
		});

		it("keeps the webview's own menu off a right click", async () => {
			render(TabBar, { props: defaultProps });

			const unhandled = await fireEvent.contextMenu(closeOf("other"));

			expect(unhandled).toBe(false);
		});

		it("closes the tab on a middle click", async () => {
			const closed: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, onauxclose: (id) => closed.push(id) },
			});

			await fireEvent(closeOf("other"), auxClick(1));

			expect(closed).toEqual(["2"]);
		});

		it("keeps the webview's default off a middle click", async () => {
			render(TabBar, { props: defaultProps });

			const unhandled = await fireEvent(closeOf("other"), auxClick(1));

			expect(unhandled).toBe(false);
		});

		it("keeps the tab open on an auxiliary click of the right button", async () => {
			const closed: string[] = [];
			render(TabBar, {
				props: { ...defaultProps, onauxclose: (id) => closed.push(id) },
			});

			await fireEvent(closeOf("other"), auxClick(2));

			expect(closed).toEqual([]);
		});

		it("forces the close while Shift is held", async () => {
			const closed: [string, boolean][] = [];
			render(TabBar, {
				props: {
					...defaultProps,
					onclose: (id, force) => closed.push([id, force]),
				},
			});

			await fireEvent.click(closeOf("other"), { shiftKey: true });

			expect(closed).toEqual([["2", true]]);
		});
	});

	describe("tab tooltips", () => {
		it("shows repoPath as title when repoPath is set", () => {
			render(TabBar, { props: defaultProps });
			const tab = screen.getByText("trunk").closest(".tab-item");
			expect(tab?.getAttribute("title")).toBe("/path/to/trunk");
		});

		it("shows repoName as title when repoPath is null", () => {
			const tabsWithNull: TabInfo[] = [
				...tabs,
				{ id: "3", repoPath: null, repoName: "orphan", dirty: false },
			];
			render(TabBar, {
				props: { ...defaultProps, tabs: tabsWithNull },
			});
			const tab = screen.getByText("orphan").closest(".tab-item");
			expect(tab?.getAttribute("title")).toBe("orphan");
		});

		it("shows 'New Tab' as title when repoPath is null and repoName is empty", () => {
			const tabsWithEmpty: TabInfo[] = [
				...tabs,
				{ id: "4", repoPath: null, repoName: "", dirty: false },
			];
			render(TabBar, {
				props: { ...defaultProps, tabs: tabsWithEmpty },
			});
			// The tab text displays "New Tab" via the existing fallback
			const newTabText = screen.getAllByText("New Tab");
			// Find the one inside a tab-item (not the new-tab button)
			const tabEl = newTabText
				.map((el) => el.closest(".tab-item"))
				.find((el) => el !== null);
			expect(tabEl?.getAttribute("title")).toBe("New Tab");
		});
	});

	describe("on a focused tab's move keys", () => {
		const strip: TabInfo[] = [
			...tabs,
			{ id: "3", repoPath: "/path/to/third", repoName: "third", dirty: false },
		];

		async function pressOn(name: string, key: Record<string, unknown>) {
			const orders: string[][] = [];
			const activated: string[] = [];
			render(TabBar, {
				props: {
					...defaultProps,
					tabs: strip,
					onactivate: (id) => activated.push(id),
					onreorder: (order) =>
						orders.push(order.map(({ repoName }) => repoName ?? "")),
				},
			});
			const tab = screen.getByRole("tab", { name });
			tab.focus();

			const unhandled = await fireEvent.keyDown(tab, key);
			return { orders, activated, unhandled };
		}

		const chords = [
			{
				chord: "Cmd+Shift+Left",
				key: "ArrowLeft",
				metaKey: true,
				order: ["other", "trunk", "third"],
			},
			{
				chord: "Cmd+Shift+Right",
				key: "ArrowRight",
				metaKey: true,
				order: ["trunk", "third", "other"],
			},
			{
				chord: "Ctrl+Shift+Left",
				key: "ArrowLeft",
				ctrlKey: true,
				order: ["other", "trunk", "third"],
			},
			{
				chord: "Ctrl+Shift+Right",
				key: "ArrowRight",
				ctrlKey: true,
				order: ["trunk", "third", "other"],
			},
		];

		it.each(chords)(
			"moves the tab one place over on $chord, in place of the key's own action",
			async ({ order, chord: _, ...key }) => {
				const { orders, unhandled } = await pressOn("other", {
					...key,
					shiftKey: true,
				});

				expect({ orders, unhandled }).toEqual({
					orders: [order],
					unhandled: false,
				});
			},
		);

		it.each(chords)(
			"moves the tab without selecting it on $chord",
			async ({ order: _, chord: __, ...key }) => {
				const { activated } = await pressOn("other", {
					...key,
					shiftKey: true,
				});

				expect(activated).toEqual([]);
			},
		);

		it.each([
			{ name: "trunk", key: "ArrowLeft" },
			{ name: "third", key: "ArrowRight" },
		])(
			"leaves the $name tab at its end of the strip on $key",
			async ({ name, key }) => {
				const { orders } = await pressOn(name, {
					key,
					metaKey: true,
					shiftKey: true,
				});

				expect(orders).toEqual([]);
			},
		);

		it.each([
			{ way: "left", order: [strip[1], strip[0], strip[2]] },
			{ way: "right", order: [strip[0], strip[2], strip[1]] },
		])("keeps the focus on a tab the strip moves $way", async ({ order }) => {
			const view = render(TabBar, { props: { ...defaultProps, tabs: strip } });
			screen.getByRole("tab", { name: "other" }).focus();

			await view.rerender({ ...defaultProps, tabs: order });

			expect(document.activeElement).toBe(
				screen.getByRole("tab", { name: "other" }),
			);
		});

		it("brings the moved tab into view", async () => {
			const moves: TabInfo[][] = [];
			const view = render(TabBar, {
				props: {
					...defaultProps,
					tabs: strip,
					onreorder: (order) => moves.push(order),
				},
			});
			const tab = screen.getByRole("tab", { name: "other" });
			tab.focus();
			const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
			scrollIntoView.mockClear();

			await fireEvent.keyDown(tab, {
				key: "ArrowRight",
				metaKey: true,
				shiftKey: true,
			});
			await view.rerender({ ...defaultProps, tabs: moves[0] });

			expect(scrollIntoView.mock.contexts).toContain(itemOf("other"));
		});
	});
});
