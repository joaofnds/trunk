import { fireEvent, render, screen } from "@testing-library/svelte";
import { type ComponentProps, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportWidthOf } from "../../__tests__/helpers/fake-resize-observer.js";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import { FILE_LABEL_STYLE } from "../../lib/file-label-style.svelte.js";
import DiffToolbar from "./DiffToolbar.svelte";

const baseProps = {
	takesComments: true,
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
	it("offers Comment File where the diff takes comments", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs", takesComments: true },
		});

		expect(
			screen.getByRole("button", { name: "Comment File" }),
		).toBeInTheDocument();
	});

	it("places Comment File right after the file name, so its arrival moves no other control", () => {
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs", takesComments: true },
		});

		const commentFile = screen.getByRole("button", { name: "Comment File" });

		const filename = commentFile.previousElementSibling as HTMLElement;
		expect(filename).toHaveClass("filename");
		expect(getComputedStyle(filename).flexGrow).toBe("1");
	});

	it("offers no Comment File where the diff takes none", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				takesComments: false,
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

	it("reports no pressed state beside the action it names", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "docs/guide.markdown",
				renderMode: "rendered",
			},
		});

		expect(screen.getByTitle("Show source")).not.toHaveAttribute(
			"aria-pressed",
		);
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

	it.each([
		["unstaged", "Stage File"],
		["staged", "Unstage File"],
	] as const)(
		"offers %s staging of a file it shows no lines for, whatever the whitespace setting",
		(diffKind, name) => {
			render(DiffToolbar, {
				props: {
					...baseProps,
					selectedPath: "assets/logo.png",
					diffKind,
					ignoreWhitespace: true,
					showsLines: false,
				},
			});

			const button = screen.getByRole("button", { name });
			expect(button).toBeEnabled();
			expect(button).not.toHaveAttribute(
				"title",
				"Staging is disabled while whitespace changes are ignored",
			);
		},
	);

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

describe("DiffToolbar file staging", () => {
	it.each([
		{ diffKind: "unstaged", name: "Stage File", handler: "onstagefile" },
		{ diffKind: "staged", name: "Unstage File", handler: "onunstagefile" },
	] as const)(
		"acts once on a double click of $name",
		async ({ diffKind, name, handler }) => {
			const act = vi.fn();
			render(DiffToolbar, {
				props: {
					...baseProps,
					selectedPath: "src/main.rs",
					diffKind,
					[handler]: act,
				},
			});
			const button = screen.getByRole("button", { name });

			await fireEvent.click(button, { detail: 1 });
			await fireEvent.click(button, { detail: 2 });

			expect(act).toHaveBeenCalledTimes(1);
		},
	);
});

describe("DiffToolbar in a narrow pane", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function renderAt(
		width: number,
		props: Partial<ComponentProps<typeof DiffToolbar>>,
	) {
		const toolbar = reportWidthOf(
			(target) => target.classList.contains("toolbar"),
			width,
		);
		render(DiffToolbar, {
			props: { ...baseProps, selectedPath: "src/main.rs", ...props },
		});
		await tick();
		return toolbar;
	}

	const WORDED = [
		{ name: "Comment File", diffKind: "commit" },
		{ name: "Discard File", diffKind: "unstaged" },
		{ name: "Stage File", diffKind: "unstaged" },
		{ name: "Unstage File", diffKind: "staged" },
	] as const;

	it.each(WORDED)(
		"draws $name as its glyph where its words do not fit",
		async ({ name, diffKind }) => {
			await renderAt(300, { diffKind });

			const action = screen.getByRole("button", { name });

			expect(action).not.toHaveTextContent(name);
			expect(action.querySelector("svg")).not.toBeNull();
		},
	);

	it.each(WORDED)(
		"spells out $name where its words fit",
		async ({ name, diffKind }) => {
			await renderAt(1000, { diffKind });

			expect(screen.getByRole("button", { name })).toHaveTextContent(name);
		},
	);

	it.each(WORDED)(
		"shows no tooltip that repeats the words $name already spells out",
		async ({ name, diffKind }) => {
			await renderAt(1000, { diffKind });

			expect(screen.getByRole("button", { name })).not.toHaveAttribute("title");
		},
	);

	it.each(WORDED)(
		"names $name in a tooltip where it draws only its glyph",
		async ({ name, diffKind }) => {
			await renderAt(300, { diffKind });

			expect(screen.getByRole("button", { name })).toHaveAttribute(
				"title",
				name,
			);
		},
	);

	it("spells out its actions again once the pane widens", async () => {
		const toolbar = await renderAt(300, { diffKind: "staged" });

		toolbar.resize(1000);
		await tick();

		expect(
			screen.getByRole("button", { name: "Unstage File" }),
		).toHaveTextContent("Unstage File");
	});

	it("drops the words of an unstaged file's actions sooner than a staged file's, since they need more room", async () => {
		await renderAt(520, { diffKind: "unstaged" });
		await renderAt(520, { diffKind: "staged" });

		expect(
			screen.getByRole("button", { name: "Stage File" }),
		).not.toHaveTextContent("Stage File");
		expect(
			screen.getByRole("button", { name: "Unstage File" }),
		).toHaveTextContent("Unstage File");
	});

	it("shows no tooltip on the way back where it spells out its label", async () => {
		await renderAt(1000, { backLabel: "Review" });

		expect(screen.getByRole("button", { name: "Review" })).not.toHaveAttribute(
			"title",
		);
	});

	it("draws the way back as its chevron where its label does not fit", async () => {
		await renderAt(300, { backLabel: "Review" });

		expect(
			screen.getByRole("button", { name: "Review" }),
		).not.toHaveTextContent("Review");
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
	it("shows both full paths for a rename with Full Path selected", () => {
		render(DiffToolbar, {
			context: new Map([[FILE_LABEL_STYLE, { current: "full-path" }]]),
			props: {
				...baseProps,
				selectedPath: "review/new.ts",
				selectedOldPath: "review/old.ts",
				selectedStatus: "Renamed",
			},
		});
		const title = "review/old.ts → review/new.ts";
		expect(screen.getByTitle(title).textContent?.trim()).toBe(title);
		expect(screen.getByTestId("diff-path")).toHaveAttribute(
			"data-path",
			"review/new.ts",
		);
	});

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

	it("offers both exact paths for a rename and identifies its destination", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "review/new.ts",
				selectedStatus: "Renamed",
				selectedOldPath: "review/old.ts",
			},
		});

		const label = screen.getByTitle("review/old.ts → review/new.ts");
		expect(label).toHaveTextContent(/^old\.ts → new\.ts review$/);
		expect(screen.getByTestId("diff-path")).toHaveAttribute(
			"data-path",
			"review/new.ts",
		);
	});

	it("offers the exact path while leading with the filename", () => {
		render(DiffToolbar, {
			props: {
				...baseProps,
				selectedPath: "src/main.rs",
				selectedStatus: "Modified",
			},
		});

		expect(screen.getByTitle("src/main.rs")).toHaveTextContent(
			/^main\.rs src$/,
		);
		expect(screen.getByTestId("diff-path")).toHaveAttribute(
			"data-path",
			"src/main.rs",
		);
	});

	it("shows no badge until a file is selected", () => {
		render(DiffToolbar, { props: { ...baseProps, selectedPath: null } });
		expect(screen.queryByTestId("diff-status-badge")).toBeNull();
	});
});
