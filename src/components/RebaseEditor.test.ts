import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exactLabel } from "../lib/relative-time.js";
import { SHOW_DELAY_MS } from "../lib/tooltip.js";
import type { RebaseTodoItem } from "../lib/types.js";
import RebaseEditor from "./RebaseEditor.svelte";

// Stub OffscreenCanvas for jsdom — used by text-measure.ts (measureTextWidth)
if (typeof globalThis.OffscreenCanvas === "undefined") {
	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return {
				font: "",
				measureText: () => ({ width: 50 }),
			};
		}
	} as unknown as typeof OffscreenCanvas;
}

// All Tauri module mocks — declared locally for proper hoisting
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
	message: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		onResized: vi.fn().mockResolvedValue(() => {}),
		onMoved: vi.fn().mockResolvedValue(() => {}),
		isMaximized: vi.fn().mockResolvedValue(false),
		isFullscreen: vi.fn().mockResolvedValue(false),
	}),
}));

vi.mock("@tauri-apps/api/menu", () => ({
	Menu: {
		new: vi.fn().mockResolvedValue({
			popup: vi.fn().mockResolvedValue(undefined),
		}),
	},
	MenuItem: { new: vi.fn().mockResolvedValue({}) },
	CheckMenuItem: { new: vi.fn().mockResolvedValue({}) },
	Submenu: { new: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@tauri-apps/plugin-window-state", () => ({}));

// Mock sortablejs — SortableJS manipulates DOM directly, not testable in jsdom
vi.mock("sortablejs", () => {
	const mockInstance = { destroy: vi.fn(), option: vi.fn() };
	const MockSortable = vi.fn().mockImplementation(() => mockInstance);
	// Sortable.create() is a static factory used by RebaseEditor
	(MockSortable as unknown as Record<string, unknown>).create = vi
		.fn()
		.mockReturnValue(mockInstance);
	return { default: MockSortable };
});

const mockInvoke = vi.mocked(invoke);

const TEST_ITEMS: RebaseTodoItem[] = [
	{
		oid: "aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
		short_oid: "aaa111a",
		summary: "feat: add login",
		author_name: "Test Author",
		author_timestamp: 1700000000,
	},
	{
		oid: "bbb222bbb222bbb2bbb222bbb222bbb2bbb222bb",
		short_oid: "bbb222b",
		summary: "fix: null check",
		author_name: "Test Author",
		author_timestamp: 1700000100,
	},
	{
		oid: "ccc333ccc333ccc3ccc333ccc333ccc3ccc333cc",
		short_oid: "ccc333c",
		summary: "docs: readme",
		author_name: "Test Author",
		author_timestamp: 1700000200,
	},
];

describe("RebaseEditor", () => {
	const scrolled: Element[] = [];
	const originalScrollIntoView = Element.prototype.scrollIntoView;

	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		scrolled.length = 0;
		Element.prototype.scrollIntoView = function scrollIntoView() {
			scrolled.push(this);
		};
	});

	afterEach(() => {
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it("renders without crashing", () => {
		const { container } = render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(container).toBeTruthy();
	});

	it("renders Interactive Rebase title", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("Interactive Rebase")).toBeInTheDocument();
	});

	it("renders branch name and base name pills", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("feature/login")).toBeInTheDocument();
		expect(screen.getByText("main")).toBeInTheDocument();
	});

	it("renders commit summaries", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		// Items are reversed for display (newest-first)
		expect(screen.getByText("docs: readme")).toBeInTheDocument();
		expect(screen.getByText("fix: null check")).toBeInTheDocument();
		expect(screen.getByText("feat: add login")).toBeInTheDocument();
	});

	it("renders commit short OIDs", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("aaa111a")).toBeInTheDocument();
		expect(screen.getByText("bbb222b")).toBeInTheDocument();
		expect(screen.getByText("ccc333c")).toBeInTheDocument();
	});

	describe("clicking a row's SHA", () => {
		beforeEach(() => {
			vi.mocked(writeText).mockClear();
			vi.mocked(writeText).mockResolvedValue(undefined);
		});

		it("copies the full oid, not the short oid", async () => {
			render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});

			await fireEvent.click(screen.getByText("aaa111a"));

			expect(vi.mocked(writeText)).toHaveBeenCalledWith(
				"aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
			);
		});

		it("does not focus the row", async () => {
			// Row 0 is focused by default, so click a non-default row's SHA: it
			// stays unfocused only if the click never reaches the row handler.
			const { container } = render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});

			await fireEvent.click(screen.getByText("bbb222b"));

			const row = container.querySelector('[data-rebase-row="1"]');
			expect(row?.classList.contains("rebase-row-focused")).toBe(false);
		});
	});

	it("renders Cancel Rebase and Start Rebase buttons", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("Cancel Rebase")).toBeInTheDocument();
		expect(screen.getByText("Start Rebase")).toBeInTheDocument();
	});

	it("paints starting in the success tone and cancelling in the danger tone", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});

		expect(screen.getByRole("button", { name: "Start Rebase" })).toHaveClass(
			"bg-success-bg",
		);
		expect(screen.getByRole("button", { name: "Cancel Rebase" })).toHaveClass(
			"bg-danger-bg",
		);
	});

	it("calls onclose when Cancel Rebase clicked", async () => {
		const onclose = vi.fn();
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose,
				onstart: vi.fn(),
			},
		});
		await fireEvent.click(screen.getByText("Cancel Rebase"));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it("renders action dropdown options", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		// Each commit has an action select. Default is "pick"
		const pickOptions = screen.getAllByText("Pick");
		expect(pickOptions.length).toBeGreaterThanOrEqual(3);
	});

	it("renders column headers", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				baseName: "main",
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("Action")).toBeInTheDocument();
		expect(screen.getByText("Message")).toBeInTheDocument();
		expect(screen.getByText("SHA")).toBeInTheDocument();
		expect(screen.getByText("Author")).toBeInTheDocument();
		expect(screen.getByText("Date")).toBeInTheDocument();
	});

	describe("date column", () => {
		const pinnedNow = new Date("2026-07-28T10:29:00Z");

		function renderItemAgedDays(days: number) {
			return render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: [
						{
							oid: "aaa111aaa111aaa1aaa111aaa111aaa1aaa111aa",
							short_oid: "aaa111a",
							summary: "feat: add login",
							author_name: "Test Author",
							author_timestamp:
								pinnedNow.getTime() / 1000 - days * 24 * 60 * 60,
						},
					],
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});
		}

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(pinnedNow);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("renders a commit from the current minute as just now", () => {
			const { getByText } = renderItemAgedDays(0);

			expect(getByText("just now")).toBeInTheDocument();
		});

		it("renders a 400-day-old commit in years", () => {
			const { getByText } = renderItemAgedDays(400);

			expect(getByText("1y ago")).toBeInTheDocument();
		});

		it("advances a mounted date cell without a prop change", async () => {
			const { getByText } = renderItemAgedDays(0);
			const dateCell = getByText("just now");

			await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1_000);

			expect(dateCell).toHaveTextContent("2h ago");
		});

		it("reveals the exact date on hover, and carries it as the accessible name", () => {
			try {
				const { getByText } = renderItemAgedDays(0);
				const exact = exactLabel(pinnedNow.getTime() / 1000);
				const cell = getByText("just now");

				expect(cell.getAttribute("title")).toBeNull();
				expect(cell.getAttribute("aria-label")).toBe(exact);

				cell.dispatchEvent(new MouseEvent("mouseenter"));
				vi.advanceTimersByTime(SHOW_DELAY_MS);

				expect(document.querySelector(".tooltip-pop")?.textContent).toBe(exact);
			} finally {
				document.querySelector(".tooltip-pop")?.remove();
			}
		});
	});

	describe("the plan's rows", () => {
		function renderEditor() {
			return render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});
		}

		function actions(container: HTMLElement) {
			return [...container.querySelectorAll("select")].map(
				(select) => select.value,
			);
		}

		it("are the options of a named listbox, each a tab stop", () => {
			renderEditor();

			const list = screen.getByRole("listbox", { name: "Commits to rebase" });

			expect(
				[...list.querySelectorAll("[data-rebase-row]")].map((row) => [
					row.getAttribute("role"),
					row.getAttribute("tabindex"),
				]),
			).toEqual([
				["option", "0"],
				["option", "0"],
				["option", "0"],
			]);
		});

		it("mark the one the cursor is on as selected", async () => {
			const { container } = renderEditor();
			const rows = [...container.querySelectorAll("[data-rebase-row]")];

			await fireEvent.click(rows[1]);

			expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
				"false",
				"true",
				"false",
			]);
		});

		it("take an action key pressed on the toolbar", async () => {
			const { container } = renderEditor();

			await fireEvent.keyDown(screen.getByRole("button", { name: "Reset" }), {
				key: "s",
			});

			expect(actions(container)).toEqual(["squash", "pick", "pick"]);
		});

		it("ignore an action key pressed outside the editor", async () => {
			const { container } = renderEditor();

			await fireEvent.keyDown(document.body, { key: "s" });

			expect(actions(container)).toEqual(["pick", "pick", "pick"]);
		});

		it("ignore an action key pressed on a row's SHA", async () => {
			const { container } = renderEditor();

			await fireEvent.keyDown(screen.getByText("ccc333c"), { key: "s" });

			expect(actions(container)).toEqual(["pick", "pick", "pick"]);
		});
	});

	describe("a right click", () => {
		function renderEditor() {
			return render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});
		}

		it("on the column header takes the native menu's place", async () => {
			renderEditor();

			const unhandled = await fireEvent.contextMenu(screen.getByText("Author"));

			expect(unhandled).toBe(false);
		});

		it.each(["Interactive Rebase", "fix: null check"])(
			"on %s leaves the native menu alone",
			async (text) => {
				renderEditor();

				const unhandled = await fireEvent.contextMenu(screen.getByText(text));

				expect(unhandled).toBe(true);
			},
		);

		it("on another editor's column header opens one menu, not two", async () => {
			vi.mocked(Menu.new).mockClear();
			renderEditor();
			const second = renderEditor();

			await fireEvent.contextMenu(within(second.container).getByText("Author"));

			await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(1));
		});
	});

	describe("with the focus on the message editor's Update button", () => {
		const REWORDING_THE_NEWEST = [
			["reword", "docs: readme"],
			["pick", "fix: null check"],
			["pick", "feat: add login"],
		];

		async function openMessageEditor() {
			const closed: true[] = [];
			const { container } = render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: () => closed.push(true),
					onstart: vi.fn(),
				},
			});
			await fireEvent.dblClick(
				container.querySelector('[data-rebase-row="0"]') as Element,
			);
			const update = await screen.findByRole("button", {
				name: "Update Message",
			});
			update.focus();

			return { container, update, closed };
		}

		function plan(container: HTMLElement) {
			return [...container.querySelectorAll("[data-rebase-row]")].map((row) => [
				row.querySelector("select")?.value,
				row.querySelector(".rebase-cell-message")?.textContent?.trim(),
			]);
		}

		it.each([
			{ name: "s", init: { key: "s" } },
			{ name: "Shift+ArrowDown", init: { key: "ArrowDown", shiftKey: true } },
		])(
			"leaves the plan and the message editor as they were on $name",
			async ({ init }) => {
				const { container, update } = await openMessageEditor();

				await fireEvent.keyDown(update, init);

				expect(plan(container)).toEqual(REWORDING_THE_NEWEST);
				expect(screen.getByRole("dialog")).toBeInTheDocument();
			},
		);

		it("cancels only the message edit on Escape", async () => {
			const { container, update, closed } = await openMessageEditor();

			await fireEvent.keyDown(update, { key: "Escape" });

			expect(screen.queryByRole("dialog")).toBeNull();
			expect(plan(container)).toEqual(REWORDING_THE_NEWEST);
			expect(closed).toEqual([]);
		});

		it("keeps a key pressed there from the window's shortcuts", async () => {
			const { update } = await openMessageEditor();
			const reached: string[] = [];
			const record = (e: KeyboardEvent) => reached.push(e.key);
			window.addEventListener("keydown", record);

			await fireEvent.keyDown(update, { key: "s" });
			window.removeEventListener("keydown", record);

			expect(reached).toEqual([]);
		});
	});

	// Every open tab's editor lives in the one document, and data-rebase-row is a
	// raw loop index, so a document-rooted query collides across instances.
	describe("with a second editor mounted", () => {
		function renderEditor() {
			return render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					baseName: "main",
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});
		}

		it("scrolls its own row into view", async () => {
			renderEditor();
			const second = renderEditor();

			await fireEvent.keyDown(
				second.container.querySelector(".rebase-editor") as Element,
				{ key: "ArrowDown" },
			);

			expect(second.container.contains(scrolled.at(-1) ?? null)).toBe(true);
		});
	});
});
