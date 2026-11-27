import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import FileRow from "./FileRow.svelte";
import "../__tests__/helpers/tauri-mock";
import { makeFile } from "../__tests__/helpers/factories";
import { treeIndent } from "../lib/chrome-heights.js";
import { FILE_LABEL_STYLE } from "../lib/file-label-style.svelte.js";

describe("FileRow", () => {
	it.each([
		[
			"option",
			"filename-first",
			"scripts/drive/native.ts",
			null,
			[8, 9, 10, 14, 15, 17],
			[],
			["na", "i", "dri"],
		],
		[
			"treeitem",
			"filename-first",
			"scripts/drive/native.ts",
			null,
			[8, 9, 10, 14, 15, 17],
			[],
			["na", "i"],
		],
		[
			"option",
			"full-path",
			"scripts/drive/native.ts",
			null,
			[8, 9, 10, 14, 15, 17],
			[],
			["dri", "na", "i"],
		],
		[
			"treeitem",
			"filename-first",
			"new/tool.ts",
			"retired/tool.ts",
			[],
			[0, 1, 2, 8, 9],
			["to", "ret"],
		],
		[
			"option",
			"filename-first",
			"src/main.ts",
			"src/entry.ts",
			[],
			[0, 1, 2, 4, 5],
			["en", "src"],
		],
	] as const)(
		"highlights the matching parts of %s labels in %s for %s",
		(role, style, path, oldPath, positions, oldPositions, expected) => {
			render(FileRow, {
				context: new Map([[FILE_LABEL_STYLE, { current: style }]]),
				props: {
					file: {
						...makeFile(path),
						old_path: oldPath,
						match: { path: positions, oldPath: oldPositions },
					},
					role,
					actionLabel: "",
					onaction: vi.fn(),
				},
			});

			const label = screen.getByTitle(oldPath ? `${oldPath} → ${path}` : path);
			if (style === "full-path") {
				expect(label).toHaveTextContent(path);
				expect(screen.getByRole(role)).toHaveAccessibleName(
					/scripts\/drive\/native\.ts/,
				);
			}
			expect(
				Array.from(label.querySelectorAll("mark"), (mark) => mark.textContent),
			).toEqual(expected);
		},
	);

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

	it.each([
		["option", "src/comments/index.ts", null, "src/comments/index.ts"],
		[
			"option",
			"published/index.ts",
			"drafts/index.ts",
			"drafts/index.ts → published/index.ts",
		],
		["treeitem", "src/comments/index.ts", null, "index.ts"],
		[
			"treeitem",
			"published/index.ts",
			"drafts/index.ts",
			"index.ts from drafts/",
		],
	] as const)(
		"labels the %s for %s with Full Path selected",
		(role, path, oldPath, label) => {
			render(FileRow, {
				context: new Map([[FILE_LABEL_STYLE, { current: "full-path" }]]),
				props: {
					file: {
						...makeFile(path, oldPath ? "Renamed" : "Modified"),
						old_path: oldPath,
					},
					role,
					actionLabel: "+",
					onaction: vi.fn(),
				},
			});
			const title = oldPath ? `${oldPath} → ${path}` : path;
			expect(screen.getByTitle(title).textContent?.trim()).toBe(label);
			expect(screen.getByRole(role)).toHaveAttribute("data-path", path);
			if (role === "treeitem") {
				expect(screen.getByRole(role)).toHaveAccessibleDescription(path);
			}
		},
	);

	it.each([
		["option", "vendor/ tools"],
		["treeitem", "vendor/"],
	] as const)("names an embedded repository in a %s", (role, label) => {
		const path = "tools/vendor/";
		render(FileRow, {
			props: {
				file: makeFile(path, "New"),
				role,
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTitle(path).textContent?.trim()).toBe(label);
		expect(screen.getByRole(role)).toHaveAttribute("data-path", path);
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

	it("shows both filenames followed by their shared directory once", () => {
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
			"util.ts → math-util.ts code",
		);
	});

	it("shows both directories when the file moved and changed name", () => {
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
		expect(row).toHaveTextContent("util.ts → math-util.ts src/ → lib/");
		expect(
			screen.getByTitle("src/util.ts → lib/math-util.ts"),
		).toBeInTheDocument();
	});

	it("shows the old and new names once beneath their shared folder", () => {
		render(FileRow, {
			props: {
				file: {
					path: "src/math-util.ts",
					old_path: "src/util.ts",
					status: "Renamed",
					is_binary: false,
				},
				role: "treeitem",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(
			screen.getByTitle("src/util.ts → src/math-util.ts"),
		).toHaveTextContent(/^util\.ts → math-util\.ts$/);
	});

	it("names the source folder of a same-name move in the destination tree", () => {
		render(FileRow, {
			props: {
				file: {
					...makeFile("published/index.ts", "Renamed"),
					old_path: "drafts/index.ts",
				},
				role: "treeitem",
				actionLabel: "−",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByRole("treeitem")).toHaveTextContent(
			"index.ts from drafts/",
		);
		expect(
			screen.getByTitle("drafts/index.ts → published/index.ts"),
		).toBeInTheDocument();
	});

	it("shows the basename alone beneath its folder", () => {
		render(FileRow, {
			props: {
				file: makeFile("src/lib/utils/short.ts", "Modified"),
				role: "treeitem",
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTitle("src/lib/utils/short.ts")).toHaveTextContent(
			/^short\.ts$/,
		);
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
				selected: true,
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

	it("acts once on a double click of its action", async () => {
		const onaction = vi.fn();
		render(FileRow, {
			props: {
				file: makeFile("a.ts", "Modified"),
				role: "option",
				actionLabel: "+",
				onaction,
			},
		});
		const stage = screen.getByRole("button", { name: "Stage file" });

		await fireEvent.click(stage, { detail: 1 });
		await fireEvent.click(stage, { detail: 2 });

		expect(onaction).toHaveBeenCalledTimes(1);
	});
});
