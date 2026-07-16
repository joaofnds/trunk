import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import DiffToolbar from "./DiffToolbar.svelte";

const baseProps = {
	contentMode: "hunk" as const,
	layoutMode: "inline" as const,
	renderMode: "source" as const,
	oncontentmodechange: () => {},
	onlayoutmodechange: () => {},
	onrendermodechange: () => {},
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
