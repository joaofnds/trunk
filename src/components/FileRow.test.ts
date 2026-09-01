import { render, screen } from "@testing-library/svelte";
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
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTestId("staging-file")).not.toHaveTextContent("→");
	});

	it("drops the repeated directory from a rename inside one folder", () => {
		render(FileRow, {
			props: {
				file: {
					path: "code/math-util.ts",
					old_path: "code/util.ts",
					status: "Renamed",
					is_binary: false,
				},
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByTestId("staging-file")).toHaveTextContent(
			"util.ts → code/math-util.ts",
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
				actionLabel: "+",
				onaction: vi.fn(),
				displayName: "short.ts",
			},
		});
		expect(screen.getByText("short.ts")).toBeInTheDocument();
		expect(screen.queryByText("src/lib/utils/short.ts")).toBeNull();
	});

	it("has listitem role when depth=0", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				actionLabel: "+",
				onaction: vi.fn(),
				depth: 0,
			},
		});
		expect(screen.getByRole("listitem")).toBeInTheDocument();
	});

	it("indents one gutter step per level, in the padding shorthand", () => {
		/* The indent has to ride in the same shorthand as the rest of the padding:
		   a padding-left from a stylesheet rule loses to this inline shorthand,
		   which is how the indent silently flattened to 8px once already. */
		const { container } = render(FileRow, {
			props: {
				file: makeFile("deep.ts", "Modified"),
				actionLabel: "+",
				onaction: vi.fn(),
				depth: 3,
			},
		});

		const row = container.querySelector("[data-testid=staging-file]");
		expect(row?.getAttribute("style")).toContain(
			`padding: 0 var(--space-2) 0 ${treeIndent(3)}`,
		);
	});

	it("has treeitem role when depth>0", () => {
		render(FileRow, {
			props: {
				file: makeFile("README.md"),
				actionLabel: "+",
				onaction: vi.fn(),
				depth: 1,
			},
		});
		expect(screen.getByRole("treeitem")).toBeInTheDocument();
	});

	it("renders New file with file path", () => {
		render(FileRow, {
			props: {
				file: makeFile("new-file.ts", "New"),
				actionLabel: "+",
				onaction: vi.fn(),
			},
		});
		expect(screen.getByText("new-file.ts")).toBeInTheDocument();
	});
});
