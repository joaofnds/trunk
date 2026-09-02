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
