import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import BranchRow from "./BranchRow.svelte";
import "../__tests__/helpers/tauri-mock";

const toggle = () => {};

describe("BranchRow", () => {
	it("renders branch name", () => {
		render(BranchRow, { props: { name: "feature/login" } });
		expect(screen.getByText("feature/login")).toBeInTheDocument();
	});

	it("calls onclick when clicked", async () => {
		let clicks = 0;
		render(BranchRow, {
			props: {
				name: "main",
				onclick: () => {
					clicks += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "main" }));

		expect(clicks).toBe(1);
	});

	it("shows error message when isError=true", () => {
		render(BranchRow, {
			props: {
				name: "main",
				isError: true,
				errorText: "Checkout failed",
			},
		});
		expect(screen.getByText("Checkout failed")).toBeInTheDocument();
	});

	it("shows default error when isError=true but no errorText", () => {
		render(BranchRow, { props: { name: "main", isError: true } });
		expect(screen.getByText(/Cannot checkout/)).toBeInTheDocument();
	});

	it("shows ahead count", () => {
		render(BranchRow, { props: { name: "main", ahead: 3 } });
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("shows behind count", () => {
		render(BranchRow, { props: { name: "main", behind: 2 } });
		expect(screen.getByText("2")).toBeInTheDocument();
	});

	it("does not show ahead/behind when both zero", () => {
		const { container } = render(BranchRow, {
			props: { name: "main", ahead: 0, behind: 0 },
		});
		// The ahead/behind span wrapper should not be present
		// when both are 0 (the {#if behind > 0 || ahead > 0} guard)
		const arrows = container.querySelectorAll("svg");
		// No ArrowUp or ArrowDown icons rendered
		expect(
			Array.from(arrows).filter(
				(svg) =>
					svg.innerHTML.includes("ArrowUp") ||
					svg.innerHTML.includes("ArrowDown"),
			),
		).toHaveLength(0);
	});
});

describe("BranchRow visibility toggle", () => {
	it("offers no toggle when the row cannot be hidden", () => {
		render(BranchRow, { props: { name: "main", isHead: true } });
		expect(
			screen.queryByLabelText(/^(Hide|Show) main$/),
		).not.toBeInTheDocument();
	});

	it("offers to hide a visible row", async () => {
		let toggles = 0;
		render(BranchRow, {
			props: {
				name: "topic",
				hidden: false,
				ontogglevisibility: () => {
					toggles += 1;
				},
			},
		});

		await fireEvent.click(screen.getByLabelText("Hide topic"));

		expect(toggles).toBe(1);
	});

	it("offers to show a hidden row", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: toggle },
		});
		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
	});

	// Acceptance #6: a hidden ref stays listed, marked as hidden, so the user can find it
	// again to turn it back on.
	it("keeps a hidden row listed and marks it hidden", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: toggle },
		});
		expect(screen.getByText("topic")).toBeInTheDocument();
		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-hidden",
			"true",
		);
	});

	// Clicking the eye must not also navigate to the ref.
	it("does not navigate when the toggle is clicked", async () => {
		let clicks = 0;
		render(BranchRow, {
			props: {
				name: "topic",
				hidden: false,
				ontogglevisibility: toggle,
				onclick: () => {
					clicks += 1;
				},
			},
		});

		await fireEvent.click(screen.getByLabelText("Hide topic"));

		expect(clicks).toBe(0);
	});

	// The eye sits beside the row's button rather than inside it, so the row's
	// menu has to be handed to it or a right-click there opens the webview's own.
	it("opens the row's menu from a right-click on the toggle", async () => {
		const menus: MouseEvent[] = [];
		render(BranchRow, {
			props: {
				name: "topic",
				ontogglevisibility: toggle,
				oncontextmenu: (event) => menus.push(event),
			},
		});

		await fireEvent.contextMenu(screen.getByLabelText("Hide topic"));

		expect(menus).toHaveLength(1);
		expect(menus[0].defaultPrevented).toBe(true);
	});
});

// WCAG 2.2 SC 2.5.8 asks for a 24x24 CSS px target (or 24px of clear spacing around a
// smaller one). The icon stays 12px; only the button's hit area grows to meet it.
// jsdom lays nothing out -- getBoundingClientRect and offsetWidth are both 0 here -- so
// this pins the declared minimum, which is what makes the box 24x24 once a real engine
// lays it out. The rendered box was measured in Chrome at 24x24 (was 20x12).
describe("BranchRow visibility toggle target size", () => {
	it("declares a 24x24 minimum on the toggle", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: toggle },
		});

		expect(screen.getByLabelText("Hide topic")).toHaveClass(
			"min-w-target",
			"min-h-target",
		);
	});
});

// The eye leaves the flow when the row is idle, so the name takes the full width
// instead of truncating against a gutter for an icon that is usually not there,
// following VS Code's SCM view (João, 2026-09-02). The pointer and focus bring it
// back in the stylesheet, which jsdom does not apply, so these read which of the
// two the row asks for.
describe("BranchRow trailing action layout", () => {
	it("takes no width while the row is idle", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: toggle },
		});

		expect(screen.getByLabelText("Hide topic").parentElement).toHaveClass(
			"hidden",
			"group-hover:flex",
			"group-focus-within:flex",
		);
	});

	// A hidden row shows its eye permanently: that is the only marker saying the ref is
	// hidden, so it cannot depend on the pointer being there.
	it("stays in the row while the ref is hidden", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: toggle },
		});

		expect(screen.getByLabelText("Show topic").parentElement).not.toHaveClass(
			"hidden",
		);
	});

	// A truncated name has to be recoverable. `title` alone does not reach keyboard users,
	// so the row also carries the full name as its accessible name.
	it("carries the full name even when it is truncated on screen", () => {
		const long = "backup-pre-update-1.25.0-2026-08-14";
		render(BranchRow, { props: { name: long } });

		expect(screen.getByRole("button", { name: long })).toBeInTheDocument();
		expect(screen.getByText(long)).toHaveAttribute("title", long);
	});
});

describe("BranchRow tone", () => {
	it.each([
		["the checked-out branch", { isHead: true }, "text-text-strong"],
		["a hidden ref", { hidden: true }, "text-text-muted"],
		["a branch being checked out", { isLoading: true }, "text-text-muted"],
		["any other branch", {}, "text-text"],
	])("draws %s in its own text color", (_, props, color) => {
		render(BranchRow, { props: { name: "topic", ...props } });

		expect(
			screen.getByRole("button", { name: "topic" }).parentElement,
		).toHaveClass(color);
	});
});

describe("BranchRow trailing controls", () => {
	it("renders the visibility toggle as its one trailing control", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: toggle },
		});

		expect(screen.getByTestId("branch-row-visibility-btn")).toBeInTheDocument();
		expect(
			screen.queryByTestId("branch-row-create-slot"),
		).not.toBeInTheDocument();
	});

	// HEAD's row is passed no ontogglevisibility, so it renders no eye.
	it("renders no trailing control on a row that has no eye", () => {
		render(BranchRow, { props: { name: "main", isHead: true } });

		expect(
			screen.queryByTestId("branch-row-visibility-btn"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("branch-row-create-slot"),
		).not.toBeInTheDocument();
	});
});
