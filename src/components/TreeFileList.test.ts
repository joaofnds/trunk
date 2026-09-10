import { fireEvent, render, screen } from "@testing-library/svelte";
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

	it("calls onfileaction when file action triggered", async () => {
		const onfileaction = vi.fn();
		const files = [makeFile("src/a.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "+",
				onfileaction,
			},
		});
		// FileRow shows action button on hover only — trigger mouseenter first
		const fileRow = screen.getByRole("listitem");
		await fireEvent.mouseEnter(fileRow);
		// Action button aria-label is "Stage file" when actionLabel="+"
		const stageBtn = screen.getByLabelText("Stage file");
		await fireEvent.click(stageBtn);
		expect(onfileaction).toHaveBeenCalledWith("src/a.ts");
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

	it("clicking a file updates visual focus to that file", async () => {
		const onfileclick = vi.fn();
		const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
				onfileclick,
			},
		});
		const list = screen.getByRole("list");

		// Keyboard-navigate down to second file (b.ts)
		await fireEvent.keyDown(list, { key: "ArrowDown" });

		// Verify b.ts is focused (has focus background)
		const items = screen.getAllByRole("listitem");
		expect(items[1].style.background).toContain("var(--color-tree-focus)");
		expect(items[2].style.background).not.toContain("var(--color-tree-focus)");

		// Click on c.ts
		await fireEvent.click(screen.getByText("c.ts"));

		// Verify c.ts is now focused and b.ts is no longer focused
		expect(items[2].style.background).toContain("var(--color-tree-focus)");
		expect(items[1].style.background).not.toContain("var(--color-tree-focus)");
	});

	it("keyboard navigation continues from clicked file", async () => {
		const onfileclick = vi.fn();
		const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
		render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
				onfileclick,
			},
		});
		const list = screen.getByRole("list");

		// Click on c.ts (last file, index 2)
		await fireEvent.click(screen.getByText("c.ts"));
		expect(onfileclick).toHaveBeenCalledWith("c.ts");

		// Press ArrowUp — should move to b.ts (index 1), not from initial position
		await fireEvent.keyDown(list, { key: "ArrowUp" });
		expect(onfileclick).toHaveBeenCalledWith("b.ts");

		// Verify b.ts is visually focused
		const items = screen.getAllByRole("listitem");
		expect(items[1].style.background).toContain("var(--color-tree-focus)");
	});

	it("renders list role in flat mode and tree role in tree mode", () => {
		const files = [makeFile("a.ts")];
		const { rerender } = render(TreeFileList, {
			props: {
				files,
				treeMode: false,
				actionLabel: "Stage",
				onfileaction: vi.fn(),
			},
		});
		expect(screen.getByRole("list")).toBeInTheDocument();

		rerender({
			files,
			treeMode: true,
			actionLabel: "Stage",
			onfileaction: vi.fn(),
		});
		expect(screen.getByRole("tree")).toBeInTheDocument();
	});
});
