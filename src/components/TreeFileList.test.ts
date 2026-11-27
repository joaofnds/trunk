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
import { makeFile } from "../__tests__/helpers/factories";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import type { ReviewTally } from "../lib/types.js";
import TreeFileList from "./TreeFileList.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

// The file lists build only the rows in view, and jsdom lays nothing out, so
// every list is given a viewport tall enough to hold all of its rows.
beforeEach(() => stubLayout({ width: 300, height: 4000 }));
afterEach(restoreLayout);
describe("TreeFileList", () => {
	it("shows the filename before its directory in the flat list", () => {
		const files = [makeFile("src/a.ts"), makeFile("b.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
			},
		});
		expect(screen.getByTitle("src/a.ts")).toHaveTextContent(/a\.ts\s*src/);
		expect(screen.getByTitle("b.ts")).toHaveTextContent("b.ts");
	});

	it("can open the tree when a filename looks like a directory key", async () => {
		const { rerender } = render(TreeFileList, {
			props: {
				files: [makeFile("docs/a.ts"), makeFile("dir:docs")],
				treeMode: false,
				actionLabel: "+",
				onfileaction: vi.fn(),
			},
		});
		await rerender({ treeMode: true });
		expect(screen.getByRole("treeitem", { name: /^docs/ })).toBeVisible();
		expect(screen.getByTitle("dir:docs")).toBeVisible();
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

	it.each([
		["src/a.ts", false],
		["README.md", true],
	])("offers a directory's action when %s is busy: %s", (busy, offered) => {
		render(TreeFileList, {
			props: {
				files: [
					makeFile("src/a.ts"),
					makeFile("src/b.ts"),
					makeFile("README.md"),
				],
				treeMode: true,
				actionLabel: "+",
				loadingFiles: new Set([busy]),
				onfileaction: vi.fn(),
				ondirectoryaction: vi.fn(),
			},
		});

		const directory = screen.getByRole("treeitem", { name: /^src/ });
		const action = within(directory.parentElement ?? document.body).queryByRole(
			"button",
			{ name: "Stage directory" },
		);
		expect(action !== null).toBe(offered);
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
		const fileText = screen.getByRole("option");
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
		const list = screen.getByRole("listbox");
		list.focus();
		await fireEvent.keyDown(list, { key: "ArrowDown" });
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

		const list = screen.getByRole("listbox");
		list.focus();
		await fireEvent.click(screen.getByText("c.ts"));
		await fireEvent.keyDown(list, { key: "ArrowUp" });

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
		expect(items).toHaveLength(3);
		expect(items[0]).toHaveTextContent("src");
		expect(items[1]).toHaveTextContent("a.ts");
		expect(items[2]).toHaveTextContent("README.md");
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

		it("marks no file while none is open and the list is not focused", () => {
			render(TreeFileList, { props: { ...props, selectedPath: null } });

			expect(screen.queryByRole("option", { selected: true })).toBeNull();
		});

		it("marks its cursor while the list holds the focus", async () => {
			render(TreeFileList, { props: { ...props, selectedPath: null } });

			screen.getByRole("listbox").focus();
			await tick();

			expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
				"a.ts",
			);
		});

		it("keeps the open file marked once the list lets go of the focus", async () => {
			render(TreeFileList, { props: { ...props, selectedPath: "b.ts" } });
			const list = screen.getByRole("listbox");
			list.focus();
			await fireEvent.keyDown(list, { key: "ArrowDown" });

			list.blur();
			await tick();

			expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
				"b.ts",
			);
		});

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

		it("opens the child under the cursor after navigating from a focused directory", async () => {
			const onfileclick = vi.fn();
			render(TreeFileList, { props: { ...props, onfileclick } });
			const directory = screen.getByRole("treeitem", { name: /src/ });
			await fireEvent.click(directory);
			await fireEvent.keyDown(directory, { key: "ArrowRight" });
			expect(
				screen.getByRole("treeitem", { selected: true }),
			).toHaveTextContent("a.ts");

			await fireEvent.keyDown(document.activeElement ?? document.body, {
				key: "Enter",
			});

			expect(onfileclick).toHaveBeenCalledExactlyOnceWith("src/a.ts");
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

	describe("with more files than its viewport holds", () => {
		const ROW = 28;
		const VIEWPORT = 10 * ROW;
		const files = Array.from({ length: 500 }, (_, i) =>
			makeFile(`file-${String(i).padStart(3, "0")}.ts`),
		);

		beforeEach(() => stubLayout({ width: 300, height: VIEWPORT }));
		afterEach(restoreLayout);

		function renderList(selectedPath: string | null = null) {
			return render(TreeFileList, {
				props: {
					files,
					treeMode: false,
					actionLabel: "Stage",
					onfileaction: () => {},
					onfileclick: () => {},
					selectedPath,
				},
			});
		}

		it("builds the rows in view and a viewport either side, not all of them", () => {
			renderList();

			const built = screen.getAllByRole("option").length;
			expect(built).toBeGreaterThanOrEqual(VIEWPORT / ROW);
			expect(built).toBeLessThanOrEqual((3 * VIEWPORT) / ROW + 1);
		});

		it("builds the rows a scroll brings into view", async () => {
			renderList();
			const list = screen.getByRole("listbox");

			list.scrollTop = 300 * ROW;
			await fireEvent.scroll(list);

			expect(screen.getByText("file-300.ts")).toBeInTheDocument();
			expect(screen.queryByText("file-000.ts")).toBeNull();
		});

		it("builds the rows in sight when the pane around it scrolls instead", async () => {
			const pane = document.createElement("div");
			pane.style.overflowY = "auto";
			document.body.append(pane);
			onTestFinished(() => pane.remove());
			stubLayout({
				width: 300,
				height: VIEWPORT,
				measure: (el) =>
					el.getAttribute("role") === "listbox"
						? { top: -pane.scrollTop, height: files.length * ROW }
						: undefined,
			});
			onTestFinished(restoreLayout);
			render(TreeFileList, {
				target: pane,
				props: {
					files,
					treeMode: false,
					actionLabel: "Stage",
					onfileaction: () => {},
				},
			});

			pane.scrollTop = 300 * ROW;
			await fireEvent.scroll(pane);

			expect(screen.getByText("file-300.ts")).toBeInTheDocument();
			expect(screen.queryByText("file-000.ts")).toBeNull();
		});

		it("scrolls to keep the cursor in sight as the arrow keys move it down", async () => {
			renderList();
			const list = screen.getByRole("listbox");
			list.focus();

			for (let i = 0; i < 15; i++) {
				await fireEvent.keyDown(list, { key: "ArrowDown" });
			}

			expect(list.scrollTop).toBe(16 * ROW - VIEWPORT);
			expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
				"file-015.ts",
			);
		});

		it("scrolls to the file its parent selects", async () => {
			renderList("file-400.ts");
			await tick();
			const list = screen.getByRole("listbox");

			expect(list.scrollTop).toBe(401 * ROW - VIEWPORT);
			expect(screen.getByText("file-400.ts")).toBeInTheDocument();
		});

		it("keeps a nested selected file visible through a list and tree round trip", async () => {
			const selectedPath = "src/review/threads/index.ts";
			const props = {
				files: [
					...files.map((file) => makeFile(`${file.path}/index.ts`)),
					makeFile("src/review/comments/index.ts"),
					makeFile(selectedPath),
				],
				treeMode: false,
				actionLabel: "Stage",
				selectedPath,
				onfileaction: () => {},
			};
			const { rerender } = render(TreeFileList, { props });
			await rerender({ ...props, treeMode: true });

			const tree = screen.getByRole("tree");
			const treeSelection = within(tree).getByRole("treeitem", {
				selected: true,
			});
			expect(within(treeSelection).getByTitle(selectedPath)).toHaveTextContent(
				"index.ts",
			);
			expect(
				within(tree).getByRole("treeitem", {
					name: /^comments/,
					expanded: true,
				}),
			).toBeInTheDocument();
			expect(tree.scrollTop).toBe((2 * files.length + 5) * ROW - VIEWPORT);

			await rerender(props);
			const list = screen.getByRole("listbox");
			const listSelection = within(list).getByRole("option", {
				selected: true,
			});
			expect(within(listSelection).getByTitle(selectedPath)).toHaveTextContent(
				"index.ts",
			);
			expect(list.scrollTop).toBe(props.files.length * ROW - VIEWPORT);
		});
	});
});
