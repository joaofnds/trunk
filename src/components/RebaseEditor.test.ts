import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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
import { exactLabel } from "../lib/relative-time.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import { SHOW_DELAY_MS } from "../lib/tooltip.js";
import type { RebaseBase, RebaseTodoItem } from "../lib/types.js";
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

const menusShown = vi.hoisted((): true[] => []);
vi.mock("@tauri-apps/api/menu", () => ({
	Menu: {
		new: vi.fn().mockResolvedValue({
			popup: async () => {
				menusShown.push(true);
			},
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
		menusShown.length = 0;
		Element.prototype.scrollIntoView = function scrollIntoView() {
			scrolled.push(this);
		};
	});

	afterEach(() => {
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	function renderEditor({ onclose = () => {} } = {}) {
		return render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				base: { kind: "branch", name: "main" },
				onclose,
				onstart: vi.fn(),
			},
		});
	}

	function actions(container: HTMLElement) {
		return [...container.querySelectorAll("select")].map(
			(select) => select.value,
		);
	}

	async function settled() {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}

	async function renderColumns() {
		renderEditor();
		await settled();

		return (column: string) =>
			screen.getByRole("slider", { name: `Resize ${column} column` });
	}

	async function press(handle: HTMLElement, key: string, times: number) {
		for (let count = 0; count < times; count++) {
			await fireEvent.keyDown(handle, { key });
		}
	}

	it.each([
		{ key: "ArrowLeft", width: "128" },
		{ key: "ArrowRight", width: "112" },
	])(
		"moves the edge before the Author column a step the way $key points",
		async ({ key, width }) => {
			const handle = await renderColumns();

			await press(handle("Author"), key, 1);

			expect(handle("Author")).toHaveAttribute("aria-valuenow", width);
		},
	);

	it("stops a key at the widest a drag makes the column", async () => {
		const handle = await renderColumns();

		await press(handle("SHA"), "ArrowLeft", 6);

		expect(handle("SHA")).toHaveAttribute("aria-valuenow", "120");
		expect(handle("SHA")).toHaveAttribute("aria-valuemax", "120");
	});

	it("stops a key at the narrowest a drag makes the column", async () => {
		const handle = await renderColumns();

		await press(handle("Date"), "ArrowRight", 13);

		expect(handle("Date")).toHaveAttribute("aria-valuenow", "66");
		expect(handle("Date")).toHaveAttribute("aria-valuemin", "66");
	});

	function widthsStored() {
		return mockInvoke.mock.calls
			.filter(([command]) => command === "prefs_set")
			.map(([, args]) => args as { key: string; value: unknown })
			.filter(({ key }) => key === "rebase_column_widths")
			.map(({ value }) => value);
	}

	it("stores nothing for a key that finds the column at its limit", async () => {
		const handle = await renderColumns();
		await press(handle("SHA"), "ArrowLeft", 5);
		const stored = widthsStored().length;

		await press(handle("SHA"), "ArrowLeft", 1);

		expect(widthsStored()).toHaveLength(stored);
	});

	it.each([
		{ limit: "widest", to: 0, width: "400" },
		{ limit: "narrowest", to: 1000, width: "66" },
	])("stops a drag of the edge at the $limit", async ({ to, width }) => {
		const handle = await renderColumns();

		await fireEvent.mouseDown(handle("Author"), { clientX: 500 });
		await fireEvent.mouseMove(window, { clientX: to });
		await fireEvent.mouseUp(window);

		expect(handle("Author")).toHaveAttribute("aria-valuenow", width);
	});

	it("stores the widths a drag left when it is released", async () => {
		const handle = await renderColumns();

		await fireEvent.mouseDown(handle("Author"), { clientX: 500 });
		await fireEvent.mouseMove(window, { clientX: 480 });
		const whileHeld = widthsStored();
		await fireEvent.mouseUp(window);

		expect(whileHeld).toEqual([]);
		expect(widthsStored()).toEqual([{ sha: 80, author: 140, date: 100 }]);
	});

	it("stores the widths a key leaves, as the release of a drag does", async () => {
		const handle = await renderColumns();

		await press(handle("Author"), "ArrowRight", 1);

		expect(mockInvoke).toHaveBeenCalledWith("prefs_set", {
			key: "rebase_column_widths",
			value: { sha: 80, author: 112, date: 100 },
		});
	});

	it("follows a drag of the edge before a column", async () => {
		const handle = await renderColumns();

		await fireEvent.mouseDown(handle("Author"), { clientX: 500 });
		await fireEvent.mouseMove(window, { clientX: 480 });
		await fireEvent.mouseUp(window);

		expect(handle("Author")).toHaveAttribute("aria-valuenow", "140");
	});

	function planRow(container: HTMLElement, index: number): Element {
		const row = container.querySelector(`[data-rebase-row="${index}"]`);
		if (!row) throw new Error(`the plan has no row ${index}`);

		return row;
	}

	it("renders without crashing", () => {
		const { container } = render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
				onclose: vi.fn(),
				onstart: vi.fn(),
			},
		});
		expect(screen.getByText("Interactive Rebase")).toBeInTheDocument();
	});

	describe("header refs", () => {
		const BASE_OID = "9959ac6f00d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5";

		function renderOnto(base: RebaseBase) {
			render(RebaseEditor, {
				props: {
					repoPath: "/test/repo",
					commits: TEST_ITEMS,
					branchName: "feature/login",
					base,
					onclose: vi.fn(),
					onstart: vi.fn(),
				},
			});
		}

		beforeEach(() => {
			vi.mocked(writeText).mockClear();
			_resetToasts();
		});

		it.each([
			["feature/login", { kind: "branch", name: "release/2.0" }],
			["release/2.0", { kind: "branch", name: "release/2.0" }],
			["9959ac6", { kind: "commit", oid: BASE_OID }],
		] as const)("draws %s as a ref chip", (name, base) => {
			renderOnto(base);

			expect(screen.getByRole("button", { name })).toHaveClass(
				"rounded-full",
				"bg-chip-accent-bg",
				"font-mono",
			);
		});

		it("copies the branch name when its chip is pressed", async () => {
			renderOnto({ kind: "branch", name: "release/2.0" });

			await fireEvent.click(
				screen.getByRole("button", { name: "feature/login" }),
			);

			expect(vi.mocked(writeText)).toHaveBeenCalledWith("feature/login");
			expect(toasts.items).toEqual([
				{
					id: expect.any(Number),
					message: "Copied feature/login",
					kind: "success",
				},
			]);
		});

		it("copies the base branch name when its chip is pressed", async () => {
			renderOnto({ kind: "branch", name: "release/2.0" });

			await fireEvent.click(
				screen.getByRole("button", { name: "release/2.0" }),
			);

			expect(vi.mocked(writeText)).toHaveBeenCalledWith("release/2.0");
			expect(toasts.items).toEqual([
				{
					id: expect.any(Number),
					message: "Copied release/2.0",
					kind: "success",
				},
			]);
		});

		describe("when the base is a commit no branch points at", () => {
			it("copies the full oid of the short one it shows", async () => {
				renderOnto({ kind: "commit", oid: BASE_OID });

				await fireEvent.click(screen.getByRole("button", { name: "9959ac6" }));

				expect(vi.mocked(writeText)).toHaveBeenCalledWith(BASE_OID);
				expect(toasts.items).toEqual([
					{
						id: expect.any(Number),
						message: "Copied 9959ac6",
						kind: "success",
					},
				]);
			});
		});

		describe("when the base is the repository root", () => {
			it("names the root without offering anything to copy", () => {
				renderOnto({ kind: "root" });

				const root = screen.getByText("root");
				expect(root).toBeVisible();
				expect(root).toHaveClass(
					"rounded-full",
					"bg-chip-accent-bg",
					"font-mono",
				);
				expect(screen.queryByRole("button", { name: "root" })).toBeNull();
			});
		});
	});

	it("renders commit summaries", () => {
		render(RebaseEditor, {
			props: {
				repoPath: "/test/repo",
				commits: TEST_ITEMS,
				branchName: "feature/login",
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
					base: { kind: "branch", name: "main" },
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
					base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
				base: { kind: "branch", name: "main" },
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
					base: { kind: "branch", name: "main" },
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

		it("are described by their validation error, which the list does not own", async () => {
			const { container } = renderEditor();
			const oldest = TEST_ITEMS.length - 1;

			await fireEvent.click(planRow(container, oldest));
			await fireEvent.keyDown(planRow(container, oldest), { key: "s" });

			expect(planRow(container, oldest)).toHaveAccessibleDescription(
				"Cannot squash the first commit",
			);
			expect(
				screen.getByText("Cannot squash the first commit"),
			).toHaveAttribute("aria-hidden", "true");
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
		it("on the column header takes the native menu's place", async () => {
			renderEditor();

			const unhandled = await fireEvent.contextMenu(screen.getByText("Author"));

			expect(unhandled).toBe(false);
		});

		it("on the column header shows the editor's own menu", async () => {
			renderEditor();

			await fireEvent.contextMenu(screen.getByText("Author"));

			await settled();

			expect(menusShown).toEqual([true]);
		});

		it.each(["Interactive Rebase", "fix: null check"])(
			"on %s leaves the native menu alone",
			async (text) => {
				renderEditor();

				const unhandled = await fireEvent.contextMenu(screen.getByText(text));

				expect(unhandled).toBe(true);
			},
		);

		it("on another editor's column header shows one menu, not two", async () => {
			renderEditor();
			const second = renderEditor();

			await fireEvent.contextMenu(within(second.container).getByText("Author"));
			await settled();

			expect(menusShown).toEqual([true]);
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
			const { container } = renderEditor({
				onclose: () => closed.push(true),
			});
			await fireEvent.dblClick(planRow(container, 0));
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

		it("draws the message editor as a dialog named by its title", async () => {
			await openMessageEditor();

			const dialog = screen.getByRole("dialog", {
				name: "Reword commit message",
			});
			expect(dialog.tagName).toBe("DIALOG");
			expect(dialog).toHaveAttribute("open");
		});

		it("hands the message editor to the editor, out of the list's rows", async () => {
			const { container } = await openMessageEditor();

			const owned = container
				.querySelector(".rebase-editor")
				?.getAttribute("aria-owns");

			expect(owned).toBeTruthy();
			expect(screen.getByRole("dialog")).toHaveAttribute("id", owned);
		});

		it("cancels only the message edit on Escape", async () => {
			const { container, update, closed } = await openMessageEditor();

			await fireEvent.keyDown(update, { key: "Escape" });

			expect(screen.queryByRole("dialog")).toBeNull();
			expect(plan(container)).toEqual(REWORDING_THE_NEWEST);
			expect(closed).toEqual([]);
		});

		it.each(["s", "Escape"])(
			"keeps %s pressed there from the window's shortcuts",
			async (key) => {
				const { update } = await openMessageEditor();
				const reached: string[] = [];
				const record = (e: KeyboardEvent) => reached.push(e.key);
				window.addEventListener("keydown", record);
				onTestFinished(() => window.removeEventListener("keydown", record));

				await fireEvent.keyDown(update, { key });

				expect(reached).toEqual([]);
			},
		);
	});

	// Every open tab's editor lives in the one document, and data-rebase-row is a
	// raw loop index, so a document-rooted query collides across instances.
	describe("with a second editor mounted", () => {
		it("scrolls its own row into view", async () => {
			renderEditor();
			const second = renderEditor();

			await fireEvent.keyDown(
				second.container.querySelector(".rebase-editor") as Element,
				{ key: "ArrowDown" },
			);

			expect(second.container.contains(scrolled.at(-1) ?? null)).toBe(true);
		});

		it("leaves the first editor's plan alone under a key pressed in its own", async () => {
			const first = renderEditor();
			const second = renderEditor();

			await fireEvent.keyDown(planRow(second.container, 0), { key: "s" });

			expect(actions(first.container)).toEqual(["pick", "pick", "pick"]);
			expect(actions(second.container)).toEqual(["squash", "pick", "pick"]);
		});
	});
});
