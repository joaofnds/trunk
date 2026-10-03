import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import TabStrip from "./TabStrip.svelte";

const tabs = createRawSnippet(() => ({
	render: () =>
		'<div><button type="button" role="tab">Commit</button><button type="button" role="tab">Amend</button></div>',
}));

describe("TabStrip", () => {
	it("is a tab list holding its tabs", () => {
		render(TabStrip, { props: { "aria-label": "Mode", children: tabs } });

		expect(screen.getByRole("tablist", { name: "Mode" })).toBeInTheDocument();
		expect(screen.getAllByRole("tab")).toHaveLength(2);
	});

	it("lays its tabs across one bar that paints its own bottom rule", () => {
		render(TabStrip, { props: { children: tabs } });

		expect(screen.getByRole("tablist")).toHaveClass(
			"flex",
			"h-bar",
			"shrink-0",
			"shadow-hairline",
		);
	});
});
