import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const tabs: TabInfo[] = [
	{ id: "1", repoPath: "/path/to/trunk", repoName: "trunk", dirty: false },
	{ id: "2", repoPath: "/path/to/other", repoName: "other", dirty: true },
];

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
			"w-control-sm",
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
});
