import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BranchRow from "./BranchRow.svelte";
import "../__tests__/helpers/tauri-mock";

describe("BranchRow", () => {
	it("renders branch name", () => {
		render(BranchRow, { props: { name: "feature/login" } });
		expect(screen.getByText("feature/login")).toBeInTheDocument();
	});

	it("calls onclick when clicked", async () => {
		const onclick = vi.fn();
		render(BranchRow, { props: { name: "main", onclick } });
		await fireEvent.click(screen.getByRole("button"));
		expect(onclick).toHaveBeenCalled();
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

	it("renders with isHead=true without error", () => {
		const { container } = render(BranchRow, {
			props: { name: "main", isHead: true },
		});
		// isHead=true sets visual emphasis on the branch name
		expect(screen.getByText("main")).toBeInTheDocument();
		expect(container.querySelector("[role='button']")).toBeInTheDocument();
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
		const ontogglevisibility = vi.fn();
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility },
		});
		await fireEvent.click(screen.getByLabelText("Hide topic"));
		expect(ontogglevisibility).toHaveBeenCalled();
	});

	it("offers to show a hidden row", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: vi.fn() },
		});
		expect(screen.getByLabelText("Show topic")).toBeInTheDocument();
	});

	// Acceptance #6: a hidden ref stays listed, marked as hidden, so the user can find it
	// again to turn it back on.
	it("keeps a hidden row listed and marks it hidden", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: vi.fn() },
		});
		expect(screen.getByText("topic")).toBeInTheDocument();
		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-hidden",
			"true",
		);
	});

	// Clicking the eye must not also navigate to the ref.
	it("does not navigate when the toggle is clicked", async () => {
		const onclick = vi.fn();
		render(BranchRow, {
			props: {
				name: "topic",
				hidden: false,
				ontogglevisibility: vi.fn(),
				onclick,
			},
		});
		await fireEvent.click(screen.getByLabelText("Hide topic"));
		expect(onclick).not.toHaveBeenCalled();
	});
});

// The eye used to sit in the row permanently as `visibility: hidden`, which keeps its
// layout box, so every name truncated ~40px early for an icon that was usually not there.
// It now leaves the flow when idle and the name takes the full width, following VS Code's
// SCM view (João, 2026-09-02).
describe("BranchRow trailing action layout", () => {
	it("takes no width while the row is idle", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		// `display: none` rather than `visibility: hidden`: the latter keeps the layout
		// box, which is what reserved the gutter the name was truncating against.
		expect(screen.getByLabelText("Hide topic")).toHaveStyle({
			display: "none",
		});
	});

	// A hidden row shows its eye permanently: that is the only marker saying the ref is
	// hidden, so it cannot depend on the pointer being there.
	it("stays in the row while the ref is hidden", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: true, ontogglevisibility: vi.fn() },
		});

		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-action-shown",
			"true",
		);
	});

	// A hover-only control is unreachable by keyboard. Focus has to reveal it too, which is
	// what VS Code does with its `.focused` selector.
	it("appears when the row takes keyboard focus", async () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		const row = screen.getByRole("button", { name: /topic/ });
		await fireEvent.focusIn(row);

		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-action-shown",
			"true",
		);
	});

	it("appears while the pointer is over the row", async () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		const row = screen.getByRole("button", { name: /topic/ });
		await fireEvent.mouseEnter(row);

		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-action-shown",
			"true",
		);
	});

	it("hides the action again when the row is neither hovered nor focused", () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-action-shown",
			"false",
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

// `display: none` takes an element out of the tab order, so revealing the button on row
// focus is what keeps it reachable: Tab lands on the row, the eye appears, Tab again lands
// on the eye. Without the focus trigger the control would be keyboard-dead.
describe("BranchRow keyboard reachability", () => {
	it("puts the action in the tab order once the row is focused", async () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		const row = screen.getByRole("button", { name: "topic" });
		await fireEvent.focusIn(row);

		// Present in the document and not display:none, so it can take focus next.
		const action = screen.getByLabelText("Hide topic");
		expect(action).toBeInTheDocument();
		expect(action).not.toHaveStyle({ display: "none" });
	});

	it("can be activated from the keyboard once revealed", async () => {
		const ontogglevisibility = vi.fn();
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility },
		});

		const row = screen.getByRole("button", { name: "topic" });
		await fireEvent.focusIn(row);
		await fireEvent.click(screen.getByLabelText("Hide topic"));

		expect(ontogglevisibility).toHaveBeenCalled();
	});

	// Focus moving into the button itself must not collapse it: `onfocusout` on the row
	// fires as focus crosses to the child, and a naive handler would hide the very control
	// the user just reached.
	it("stays visible when focus moves from the row onto the action", async () => {
		render(BranchRow, {
			props: { name: "topic", hidden: false, ontogglevisibility: vi.fn() },
		});

		const row = screen.getByRole("button", { name: "topic" });
		await fireEvent.focusIn(row);
		const action = screen.getByLabelText("Hide topic");
		await fireEvent.focusIn(action);

		expect(screen.getByTestId("branch-row")).toHaveAttribute(
			"data-action-shown",
			"true",
		);
	});
});
