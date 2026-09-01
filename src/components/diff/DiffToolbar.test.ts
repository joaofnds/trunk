import { render, screen } from "@testing-library/svelte";
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
