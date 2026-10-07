import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import DiffToolbar from "./DiffToolbar.svelte";

const baseProps = {
	contentMode: "hunk" as const,
	layoutMode: "inline" as const,
	renderMode: "source" as const,
	renderedStyle: "copies" as const,
	oncontentmodechange: () => {},
	onlayoutmodechange: () => {},
	onrendermodechange: () => {},
	onrenderedstylechange: () => {},
	diffKind: "commit" as const,
	hunkOperationInFlight: false,
	ignoreWhitespace: false,
	showInvisibles: false,
	wordWrap: false,
	onignorewhitespacechange: () => {},
	onshowinvisibleschange: () => {},
	onwordwrapchange: () => {},
	onstagefile: () => {},
	onunstagefile: () => {},
	ondiscardfile: () => {},
	oncommentfile: () => {},
	onclose: () => {},
};

describe("DiffToolbar review actions", () => {
	it("hides Comment File under Hide all", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				reviewCommentsVisible: true,
				reviewFilter: "none",
			},
		});

		expect(screen.queryByRole("button", { name: "Comment File" })).toBeNull();
	});
});

describe("DiffToolbar comment badge", () => {
	it("counts the file's threads by state beside its path", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				commentTally: { open: 2, addressed: 1 },
			},
		});

		expect(
			screen.getByRole("img", {
				name: "3 review comments, 2 open and 1 addressed",
			}),
		).toBeInTheDocument();
	});

	it("shows no count under Hide all", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				reviewFilter: "none",
				commentTally: { open: 2 },
			},
		});

		expect(screen.queryByRole("img", { name: /review comment/ })).toBeNull();
	});
});

describe("DiffToolbar Source|Rendered toggle", () => {
	it("shows the toggle when the selected file is markdown", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "README.md" },
		});
		expect(screen.getByTitle("Show rendered markdown")).toBeInTheDocument();
	});

	it("hides the toggle for non-markdown files", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs" },
		});
		expect(screen.queryByTitle("Show rendered markdown")).toBeNull();
		expect(screen.queryByTitle("Show source")).toBeNull();
	});

	it("labels the toggle to return to source when already rendered", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "docs/guide.markdown",
				renderMode: "rendered",
			},
		});
		expect(screen.getByTitle("Show source")).toBeInTheDocument();
	});
});

describe("DiffToolbar content-mode toggle", () => {
	it("offers the toggle for a commit diff", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs", diffKind: "commit" },
		});
		expect(screen.getByTitle("Show full file")).toBeInTheDocument();
	});

	it("offers no toggle in a current-file view", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				diffKind: "current_file",
			},
		});
		expect(screen.queryByTitle("Show full file")).toBeNull();
		expect(screen.queryByTitle("Show hunks")).toBeNull();
	});
});

describe("DiffToolbar invisibles toggle", () => {
	it("disables the button with an explanation in rendered mode", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "README.md",
				renderMode: "rendered",
			},
		});
		const btn = screen.getByTitle(
			"Invisible characters aren't rendered in preview",
		);
		expect(btn).toBeDisabled();
	});

	it("stays enabled in source mode", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "README.md", renderMode: "source" },
		});
		const btn = screen.getByTitle("Show invisible characters");
		expect(btn).toBeEnabled();
	});
});

describe("DiffToolbar toggles", () => {
	it("marks the toggles that are on as pressed", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				ignoreWhitespace: true,
				showInvisibles: true,
			},
		});

		expect(screen.getByTitle("Ignore whitespace changes")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByTitle("Show invisible characters")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByTitle("Side-by-side view")).not.toHaveAttribute(
			"aria-pressed",
		);
	});

	it("disables staging while whitespace changes are ignored, and says why", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				diffKind: "unstaged",
				ignoreWhitespace: true,
			},
		});

		const stage = screen.getByRole("button", { name: /Stage File/ });
		expect(stage).toBeDisabled();
		expect(stage).toHaveAttribute(
			"title",
			"Staging is disabled while whitespace changes are ignored",
		);
		expect(screen.getByRole("button", { name: "Discard File" })).toBeEnabled();
	});

	it("closes the pane from a labelled control", async () => {
		let closes = 0;
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				onclose: () => {
					closes += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Close diff" }));

		expect(closes).toBe(1);
	});
});

describe("DiffToolbar way back", () => {
	it("goes back to where the diff was opened from", async () => {
		let closes = 0;
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				backLabel: "Review",
				onclose: () => {
					closes += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Review" }));

		expect(closes).toBe(1);
	});

	it("offers no way back where the diff has nothing behind it", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs" },
		});

		expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
	});
});

describe("DiffToolbar word wrap toggle", () => {
	afterEach(restoreLayout);

	it("offers word wrap when the diff font is fixed-pitch", () => {
		stubLayout({ width: 900, height: 400 });

		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs" },
		});

		const toggle = screen.getByTitle("Toggle word wrap") as HTMLButtonElement;
		expect(toggle.disabled).toBe(false);
	});

	it("disables the toggle with an explanation when the font is not fixed-pitch", () => {
		stubLayout({
			width: 900,
			height: 400,
			measure: (el) =>
				el.textContent?.startsWith("W") ? { width: 1200 } : undefined,
		});

		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs" },
		});

		const toggle = screen.getByTitle(
			"Word wrap needs a fixed-pitch diff font",
		) as HTMLButtonElement;
		expect(toggle.disabled).toBe(true);
	});
});

describe("DiffToolbar rendered markdown", () => {
	// Inline rendered markdown always shows the merged copy now, so there is no
	// style to choose and no control for it.
	it("offers no merged-style control", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "README.md",
				renderMode: "rendered" as const,
			},
		});

		expect(screen.queryByTitle("Show merged changes")).toBeNull();
		expect(screen.queryByTitle("Show before and after copies")).toBeNull();
	});

	// Split still shows the before/after columns, so side-by-side stays reachable
	// for markdown: nothing disables the layout toggle any more.
	it("leaves the layout toggle enabled for a rendered markdown file", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "README.md",
				renderMode: "rendered" as const,
			},
		});

		expect(screen.getByTitle("Side-by-side view")).toBeEnabled();
	});
});

describe("DiffToolbar file header", () => {
	it("marks the file with its status letter", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				selectedStatus: "Added" as const,
			},
		});
		expect(screen.getByTitle("Added")).toHaveTextContent("A");
	});

	it("names both paths when the file was renamed", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "code/math-util.ts",
				selectedStatus: "Renamed" as const,
				selectedOldPath: "util.ts",
			},
		});
		expect(screen.getByTestId("diff-old-path")).toHaveTextContent("util.ts");
		expect(screen.getByTestId("diff-path")).toHaveTextContent(
			"code/math-util.ts",
		);
	});

	it("names one path when the file was not renamed", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				selectedStatus: "Modified" as const,
				selectedOldPath: null,
			},
		});
		expect(screen.queryByTestId("diff-old-path")).toBeNull();
		expect(screen.getByTestId("diff-path")).toHaveTextContent("src/main.rs");
	});

	it("shows no badge until a file is selected", () => {
		render(DiffToolbar, { props: { ...baseProps, selectedPath: null } });
		expect(screen.queryByTestId("diff-status-badge")).toBeNull();
	});
});
