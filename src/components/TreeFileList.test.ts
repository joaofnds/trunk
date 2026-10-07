import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { makeFile } from "../__tests__/helpers/factories";
import type { ReviewTally } from "../lib/types.js";
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

	it("rolls descendant comment counts by state into a collapsed directory", () => {
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
				commentTallies: new Map<string, ReviewTally>([
					["src/a.ts", { addressed: 1 }],
					["src/b.ts", { open: 2 }],
				]),
			},
		});

		const directory = screen.getByRole("treeitem", { name: /src/ });
		const pills = [...directory.querySelectorAll(".comment-badge-pill")];
		expect(pills.map((pill) => pill.textContent?.trim())).toEqual(["2", "1"]);
		expect(pills[0]).toHaveClass("tone-open");
		expect(pills[1]).toHaveClass("tone-addressed");
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

	it("takes the focus back from a file's button", async () => {
		render(TreeFileList, {
			props: {
				files: [makeFile("a.ts")],
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: () => {},
			},
		});

		screen.getByRole("option").focus();

		expect(screen.getByRole("listbox")).toHaveFocus();
	});

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

	it("leaves Space on a file to the list's scroll", async () => {
		const opened: string[] = [];
		render(TreeFileList, {
			props: {
				files: [makeFile("a.ts")],
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: () => {},
				onfileclick: (path) => opened.push(path),
			},
		});

		const scrolls = await fireEvent.keyDown(screen.getByRole("listbox"), {
			key: " ",
		});

		expect(scrolls).toBe(true);
		expect(opened).toEqual([]);
	});

	describe("when its parent selects a file", () => {
		const props = {
			files: [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
			treeMode: false,
			actionLabel: "Stage",
			onfileaction: () => {},
		};

		it("moves the cursor to it from a row still shown", async () => {
			const { rerender } = render(TreeFileList, {
				props: { ...props, selectedPath: "a.ts" },
			});

			await rerender({ ...props, selectedPath: "c.ts" });

			expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
				"c.ts",
			);
		});

		it("keeps the cursor on it when the list becomes a tree", async () => {
			const { rerender } = render(TreeFileList, {
				props: { ...props, selectedPath: "c.ts" },
			});

			await rerender({ ...props, selectedPath: "c.ts", treeMode: true });

			expect(
				screen.getByRole("treeitem", { selected: true }),
			).toHaveTextContent("c.ts");
		});

		it("moves the cursor to a file selected again after the selection was dropped", async () => {
			const { rerender } = render(TreeFileList, {
				props: { ...props, selectedPath: "c.ts" },
			});
			await rerender({ ...props, selectedPath: null });
			await fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });

			await rerender({ ...props, selectedPath: "c.ts" });

			expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
				"c.ts",
			);
		});
	});

	describe("when the cursor is on a directory", () => {
		const props = {
			files: [makeFile("src/a.ts"), makeFile("README.md")],
			treeMode: true,
			actionLabel: "Stage",
			onfileaction: () => {},
		};

		it("leaves the focus on a clicked directory", async () => {
			render(TreeFileList, { props });
			const directory = screen.getByRole("treeitem", { name: /src/ });

			await fireEvent.click(directory);

			expect(directory).toHaveFocus();
			expect(directory).toHaveAttribute("aria-expanded", "true");
		});

		// Its button answers both keys with a click of its own, so the list
		// acting on them too would fold it straight back.
		it.each(["Enter", " "])(
			"leaves %j to a directory that holds the focus",
			async (key) => {
				const opened: string[] = [];
				render(TreeFileList, {
					props: {
						...props,
						selectedPath: "README.md",
						onfileclick: (path) => opened.push(path),
					},
				});
				const directory = screen.getByRole("treeitem", { name: /src/ });
				await fireEvent.click(directory);

				const unhandled = await fireEvent.keyDown(directory, { key });

				expect(unhandled).toBe(true);
				expect(directory).toHaveAttribute("aria-expanded", "true");
				expect(opened).toEqual([]);
			},
		);

		it("keeps the cursor on the selected file when a directory is clicked", async () => {
			render(TreeFileList, {
				props: { ...props, selectedPath: "README.md" },
			});

			await fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));

			expect(
				screen.getByRole("treeitem", { selected: true }),
			).toHaveTextContent("README.md");
		});

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
