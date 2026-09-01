import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import DirectoryRow from "./DirectoryRow.svelte";
import "../__tests__/helpers/tauri-mock";
import type { DirectoryNode } from "../lib/build-tree";
import { treeIndent } from "../lib/chrome-heights.js";

describe("DirectoryRow", () => {
	function makeNode(name: string, childCount: number = 2): DirectoryNode {
		const children = Array.from({ length: childCount }, (_, i) => ({
			type: "file" as const,
			name: `file${i}.ts`,
			path: `${name}/file${i}.ts`,
			file: {
				path: `${name}/file${i}.ts`,
				old_path: null,
				status: "Modified" as const,
				is_binary: false,
			},
		}));
		return { type: "directory", name, path: name, children };
	}

	it("indents one gutter step per level, in the padding shorthand", () => {
		/* Same construction and same trap as FileRow: a padding-left from a
		   stylesheet rule loses to this inline shorthand, which is how the indent
		   silently flattened to 8px at every depth once already. */
		const { container } = render(DirectoryRow, {
			props: {
				node: makeNode("src"),
				depth: 3,
				expanded: false,
				focused: false,
				ontoggle: vi.fn(),
			},
		});

		const row = container.querySelector("[role=treeitem]");
		expect(row?.getAttribute("style")).toContain(
			`padding: 0 var(--space-2) 0 ${treeIndent(3)}`,
		);
	});

	it("renders directory name", () => {
		render(DirectoryRow, {
			props: {
				node: makeNode("src"),
				depth: 0,
				expanded: false,
				focused: false,
				ontoggle: vi.fn(),
			},
		});
		expect(screen.getByText("src")).toBeInTheDocument();
	});

	it("renders file count", () => {
		render(DirectoryRow, {
			props: {
				node: makeNode("src", 3),
				depth: 0,
				expanded: false,
				focused: false,
				ontoggle: vi.fn(),
			},
		});
		expect(screen.getByText("(3)")).toBeInTheDocument();
	});

	it("has treeitem role and aria-expanded", () => {
		render(DirectoryRow, {
			props: {
				node: makeNode("src"),
				depth: 0,
				expanded: true,
				focused: false,
				ontoggle: vi.fn(),
			},
		});
		const item = screen.getByRole("treeitem");
		expect(item).toBeInTheDocument();
		expect(item.getAttribute("aria-expanded")).toBe("true");
	});

	it("sets aria-expanded=false when collapsed", () => {
		render(DirectoryRow, {
			props: {
				node: makeNode("src"),
				depth: 0,
				expanded: false,
				focused: false,
				ontoggle: vi.fn(),
			},
		});
		const item = screen.getByRole("treeitem");
		expect(item.getAttribute("aria-expanded")).toBe("false");
	});

	it("calls ontoggle when clicked", async () => {
		const ontoggle = vi.fn();
		render(DirectoryRow, {
			props: {
				node: makeNode("src"),
				depth: 0,
				expanded: false,
				focused: false,
				ontoggle,
			},
		});
		await fireEvent.click(screen.getByRole("treeitem"));
		expect(ontoggle).toHaveBeenCalled();
	});
});
