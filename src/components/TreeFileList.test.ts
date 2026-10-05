import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { makeFile } from "../__tests__/helpers/factories";
import type { ReviewTone } from "../lib/types.js";
import TreeFileList from "./TreeFileList.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

describe("TreeFileList", () => {
	it("renders file paths in flat mode", () => {
		const files = [makeFile("src/a.ts"), makeFile("b.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
			},
		});
		expect(screen.getByText("src/a.ts")).toBeInTheDocument();
		expect(screen.getByText("b.ts")).toBeInTheDocument();
	});

	it("renders tree structure in tree mode", () => {
		const files = [
			makeFile("src/lib/utils.ts"),
			makeFile("src/lib/types.ts"),
			makeFile("README.md"),
		];
		render(TreeFileList, {
			props: {
				files,
				treeMode: true,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
			},
		});
		// In tree mode, "src/lib" should be a compressed directory name
		expect(screen.getByText("src/lib")).toBeInTheDocument();
		expect(screen.getByText("README.md")).toBeInTheDocument();
	});

	it("rolls descendant comment counts and strongest tone into a collapsed directory", () => {
		const files = [makeFile("src/a.ts"), makeFile("src/b.ts")];

		render(TreeFileList, {
			props: {
				files,
				treeMode: true,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
				commentCounts: new Map([
					["src/a.ts", 1],
					["src/b.ts", 2],
				]),
				commentTones: new Map<string, ReviewTone>([
					["src/a.ts", "addressed"],
					["src/b.ts", "open"],
				]),
			},
		});

		const directory = screen.getByRole("treeitem", { name: /src/ });
		const badge = directory.querySelector(".comment-badge");
		expect(badge).toHaveTextContent("3");
		expect(badge).toHaveClass("tone-open");
		expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
	});

	it("stages a file from its action without opening it", async () => {
		const seen: string[] = [];
		render(TreeFileList, {
			props: {
				files: [makeFile("src/a.ts")],
				treeMode: false,
				actionLabel: "+",
				onfileaction: (path) => seen.push(`stage ${path}`),
				onfileclick: (path) => seen.push(`open ${path}`),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Stage file" }));

		expect(seen).toEqual(["stage src/a.ts"]);
	});

	it("calls onfileclick when file clicked", async () => {
		const onfileclick = vi.fn();
		const files = [makeFile("src/a.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
				onfileclick,
			},
		});
		// Click on the file name text
		const fileText = screen.getByText("src/a.ts");
		await fireEvent.click(fileText);
		expect(onfileclick).toHaveBeenCalledWith("src/a.ts");
	});

	it("moves the cursor to a clicked file", async () => {
		render(TreeFileList, {
			props: {
				files: [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: () => {},
			},
		});
		await fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"b.ts",
		);

		await fireEvent.click(screen.getByText("c.ts"));

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"c.ts",
		);
	});

	it("moves on from a clicked file with the arrow keys", async () => {
		const opened: string[] = [];
		render(TreeFileList, {
			props: {
				files: [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: () => {},
				onfileclick: (path) => opened.push(path),
			},
		});

		await fireEvent.click(screen.getByText("c.ts"));
		await fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });

		expect(opened).toEqual(["c.ts", "b.ts"]);
		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"b.ts",
		);
	});

	// The list holds the keys, so a click that gave a row's button the focus
	// would otherwise take the arrow keys away with it.
	it.each([
		["a file", false, "option"],
		["a directory", true, "treeitem"],
	] as const)(
		"takes the focus back from %s that was clicked",
		async (_, treeMode, role) => {
			render(TreeFileList, {
				props: {
					files: [makeFile("src/a.ts")],
					treeMode,
					actionLabel: "Stage",
					onfileaction: () => {},
				},
			});
			const row = screen.getAllByRole(role)[0];
			row.focus();

			await fireEvent.click(row);

			expect(screen.getByRole(treeMode ? "tree" : "listbox")).toHaveFocus();
		},
	);

	it("is a listbox of options when flat and a tree of items otherwise", async () => {
		const props = {
			files: [makeFile("src/a.ts"), makeFile("README.md")],
			actionLabel: "Stage",
			onfileaction: () => {},
		};
		const { rerender } = render(TreeFileList, {
			props: { ...props, treeMode: false },
		});
		expect(
			within(screen.getByRole("listbox")).getAllByRole("option"),
		).toHaveLength(2);

		await rerender({ ...props, treeMode: true });

		const items = within(screen.getByRole("tree")).getAllByRole("treeitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("src");
		expect(items[1]).toHaveTextContent("README.md");
	});

	// Opening the selected file again is how a click closes its diff.
	it("leaves the selected file open when the arrow keys reach it", async () => {
		const opened: string[] = [];
		render(TreeFileList, {
			props: {
				files: [makeFile("src/a.ts"), makeFile("README.md")],
				treeMode: true,
				actionLabel: "Stage",
				onfileaction: () => {},
				onfileclick: (path) => opened.push(path),
				selectedPath: "README.md",
			},
		});
		const tree = screen.getByRole("tree");
		await fireEvent.click(screen.getByText("src"));

		await fireEvent.keyDown(tree, { key: "ArrowDown" });
		await fireEvent.keyDown(tree, { key: "ArrowDown" });

		expect(opened).toEqual(["src/a.ts"]);
		expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent(
			"README.md",
		);
	});

	describe("when the cursor is on a directory", () => {
		it.each(["Enter", " "])(
			"keeps the cursor on a clicked directory while a file is selected, so %j closes it",
			async (key) => {
				render(TreeFileList, {
					props: {
						files: [makeFile("src/a.ts"), makeFile("README.md")],
						treeMode: true,
						actionLabel: "Stage",
						onfileaction: () => {},
						selectedPath: "README.md",
					},
				});
				await fireEvent.click(screen.getByText("src"));
				expect(
					screen.getByRole("treeitem", { expanded: true }),
				).toBeInTheDocument();

				await fireEvent.keyDown(screen.getByRole("tree"), { key });

				expect(
					screen.getByRole("treeitem", { expanded: false }),
				).toBeInTheDocument();
			},
		);

		it.each(["Enter", " ", "ArrowRight"])(
			"opens it once on %j",
			async (key) => {
				render(TreeFileList, {
					props: {
						files: [makeFile("src/a.ts")],
						treeMode: true,
						actionLabel: "Stage",
						onfileaction: () => {},
					},
				});

				await fireEvent.keyDown(screen.getByRole("tree"), { key });

				expect(
					screen.getByRole("treeitem", { expanded: true }),
				).toHaveTextContent("src");
			},
		);

		it.each(["Enter", " ", "ArrowLeft"])(
			"closes it again on %j",
			async (key) => {
				render(TreeFileList, {
					props: {
						files: [makeFile("src/a.ts")],
						treeMode: true,
						actionLabel: "Stage",
						onfileaction: () => {},
					},
				});
				const tree = screen.getByRole("tree");
				await fireEvent.keyDown(tree, { key: "Enter" });

				await fireEvent.keyDown(tree, { key });

				expect(
					screen.getByRole("treeitem", { expanded: false }),
				).toHaveTextContent("src");
			},
		);
	});
});
