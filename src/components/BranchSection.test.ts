import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import BranchSection from "./BranchSection.svelte";
import "../__tests__/helpers/tauri-mock";

const emptySnippet = createRawSnippet(() => ({
	render: () => "",
}));

describe("BranchSection", () => {
	it("renders label with count", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 5,
				expanded: false,
				ontoggle: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(screen.getByText("Branches (5)")).toBeInTheDocument();
	});

	it("calls ontoggle when header clicked", async () => {
		const ontoggle = vi.fn();
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle,
				children: emptySnippet,
			},
		});
		await fireEvent.click(screen.getByRole("button"));
		expect(ontoggle).toHaveBeenCalled();
	});

	it("shows create button when showCreateButton=true", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				showCreateButton: true,
				oncreate: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(screen.getByLabelText("Create new branch")).toBeInTheDocument();
	});

	it("hides create button by default", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(screen.queryByLabelText("Create new branch")).toBeNull();
	});

	it("calls oncreate when create button clicked", async () => {
		const oncreate = vi.fn();
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				showCreateButton: true,
				oncreate,
				children: emptySnippet,
			},
		});
		await fireEvent.click(screen.getByLabelText("Create new branch"));
		expect(oncreate).toHaveBeenCalled();
	});
});

describe("BranchSection visibility toggle", () => {
	it("hides the toggle when the section does not offer one", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(
			screen.queryByLabelText("Hide all Branches refs"),
		).not.toBeInTheDocument();
	});

	it("offers to hide every ref of a visible section", async () => {
		const ontogglevisibility = vi.fn();
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				hidden: false,
				ontogglevisibility,
				children: emptySnippet,
			},
		});
		await fireEvent.click(screen.getByLabelText("Hide all Branches refs"));
		expect(ontogglevisibility).toHaveBeenCalled();
	});

	it("offers to show a hidden section", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				hidden: true,
				ontogglevisibility: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(screen.getByLabelText("Show all Branches refs")).toBeInTheDocument();
	});

	// The header toggle must not also expand or collapse the section: two gestures,
	// two outcomes, and the same click would otherwise do both.
	it("does not toggle the section open when the visibility button is clicked", async () => {
		const ontoggle = vi.fn();
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle,
				hidden: false,
				ontogglevisibility: vi.fn(),
				children: emptySnippet,
			},
		});
		await fireEvent.click(screen.getByLabelText("Hide all Branches refs"));
		expect(ontoggle).not.toHaveBeenCalled();
	});
});
