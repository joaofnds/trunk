import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import FileRow from "./FileRow.svelte";
import "../__tests__/helpers/tauri-mock";
import { makeFile } from "../__tests__/helpers/factories";
import { treeIndent } from "../lib/chrome-heights.js";

describe("FileRow", () => {
	it("renders file path", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md", "Modified"),
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByText("README.md")).toBeInTheDocument();
	});

	// The backend sends old_path as JSON null, not an absent key, so a row that
	// only checks for undefined renders an arrow with nothing before it.
	it("shows no rename arrow when old_path is null", () => {
		render(FileRow, {
			props: {
				file: {
					path: "src/added.ts",
					old_path: null,
					status: "New",
					is_binary: false,
				},
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTestId("staging-file")).not.toHaveTextContent("→");
	});

	it("names both paths in full for a rename inside one folder", () => {
		render(FileRow, {
			props: {
				file: {
					path: "code/math-util.ts",
					old_path: "code/util.ts",
					status: "Renamed",
					is_binary: false,
				},
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTestId("staging-file")).toHaveTextContent(
			"code/util.ts → code/math-util.ts",
		);
	});

	it("keeps both paths whole when the file moved between folders", () => {
		render(FileRow, {
			props: {
				file: {
					path: "lib/math-util.ts",
					old_path: "src/util.ts",
					status: "Renamed",
					is_binary: false,
				},
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		const row = screen.getByTestId("staging-file");
		expect(row).toHaveTextContent("src/util.ts → lib/math-util.ts");
	});

	it("shows only the new basename for a rename in tree mode", () => {
		render(FileRow, {
			props: {
				file: {
					path: "src/math-util.ts",
					old_path: "src/util.ts",
					status: "Renamed",
					is_binary: false,
				},
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
				displayName: "math-util.ts",
			},
		});
		const row = screen.getByTestId("staging-file");
		expect(row).toHaveTextContent("util.ts");
		expect(row).toHaveTextContent("math-util.ts");
		expect(row).not.toHaveTextContent("src/");
	});

	it("renders displayName when provided", () => {
		render(FileRow, {
			props: {
				file: makeFile("src/lib/utils/short.ts", "Modified"),
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
				displayName: "short.ts",
			},
		});
		expect(screen.getByText("short.ts")).toBeInTheDocument();
		expect(screen.queryByText("src/lib/utils/short.ts")).toBeNull();
	});

	it.each([
		["option", 0],
		["treeitem", 0],
		["treeitem", 2],
	] as const)("is the %s its list makes it at depth %i", (role, depth) => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role,
				actionLabel: "+",
				onaction: () => {},
				depth,
			},
		});

		expect(screen.getByRole(role)).toHaveTextContent("README.md");
	});

	it("states its level only in a tree", () => {
		const props = {
			file: makeFile("README.md"),
			actionLabel: "+",
			onaction: () => {},
			depth: 2,
		};
		const { unmount } = render(FileRow, {
			props: { ...props, role: "treeitem" },
		});
		expect(screen.getByRole("treeitem")).toHaveAttribute("aria-level", "3");
		unmount();

		render(FileRow, { props: { ...props, role: "option", depth: 0 } });

		expect(screen.getByRole("option")).not.toHaveAttribute("aria-level");
	});

	it("indents one gutter step per level", () => {
		render(FileRow, {
			props: {
				file: makeFile("deep.ts", "Modified"),
				role: "treeitem",
				actionLabel: "+",
				onaction: () => {},
				depth: 3,
			},
		});

		const label = screen.getByRole("treeitem").firstElementChild;
		expect((label as HTMLElement).style.paddingLeft).toBe(treeIndent(3));
	});

	it("marks the row the list's cursor is on", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				actionLabel: "+",
				onaction: () => {},
				focused: true,
			},
		});

		expect(screen.getByRole("option", { selected: true })).toBeInTheDocument();
	});

	it("runs its action without opening the file", async () => {
		const seen: string[] = [];
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				actionLabel: "+",
				onaction: () => seen.push("action"),
				onclick: () => seen.push("open"),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Stage file" }));

		expect(seen).toEqual(["action"]);
	});

	it.each([
		["a loading file", { isLoading: true, actionLabel: "+" }],
		["a list with no action", { isLoading: false, actionLabel: "" }],
	])("offers no action on %s", (_, state) => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				onaction: () => {},
				...state,
			},
		});

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("opens the row's menu from its action too", async () => {
		const menus: MouseEvent[] = [];
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				actionLabel: "+",
				onaction: () => {},
				oncontextmenu: (event) => menus.push(event),
			},
		});

		const onRow = await fireEvent.contextMenu(screen.getByRole("option"));
		const onAction = await fireEvent.contextMenu(
			screen.getByRole("button", { name: "Stage file" }),
		);

		expect(menus).toHaveLength(2);
		expect([onRow, onAction]).toEqual([false, false]);
	});

	// The list holds the focus and the keys, so a row that took a Tab stop
	// would take the arrow keys away with it.
	it("stays out of the Tab order", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				actionLabel: "+",
				onaction: () => {},
			},
		});

		expect(screen.getByRole("option")).toHaveAttribute("tabindex", "-1");
	});

	it("dims a file that is loading", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				role: "option",
				actionLabel: "+",
				onaction: () => {},
				isLoading: true,
			},
		});

		expect(screen.getByRole("option").parentElement).toHaveClass(
			"text-text-muted",
		);
	});

	it("renders New file with file path", () => {
		render(FileRow, {
			props: {
				file: makeFile("new-file.ts", "New"),
				role: "option",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByText("new-file.ts")).toBeInTheDocument();
	});
});
