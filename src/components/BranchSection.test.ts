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
				groupState: "none" as const,
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
				groupState: "all" as const,
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
				groupState: "none" as const,
				ontogglevisibility: vi.fn(),
				children: emptySnippet,
			},
		});
		await fireEvent.click(screen.getByLabelText("Hide all Branches refs"));
		expect(ontoggle).not.toHaveBeenCalled();
	});
});

// WCAG 2.2 SC 2.5.8 asks for a 24x24 CSS px target. The icon stays 12px; only the
// button's hit area grows to meet it. jsdom lays nothing out, so this pins the declared
// minimum rather than a measured box; see BranchRow.test.ts for the note in full.
describe("BranchSection visibility toggle target size", () => {
	it("declares a 24x24 minimum on the toggle", () => {
		render(BranchSection, {
			props: {
				label: "Branches",
				count: 3,
				expanded: false,
				ontoggle: vi.fn(),
				groupState: "none" as const,
				ontogglevisibility: vi.fn(),
				children: emptySnippet,
			},
		});
		expect(screen.getByLabelText("Hide all Branches refs")).toHaveStyle({
			minWidth: "var(--target-min)",
			minHeight: "var(--target-min)",
		});
	});
});

// TRUNK-187: the trailing eyes did not line up in a column. Section headers sat 12px
// from the sidebar edge, branch rows 16px, the remote sub-header 8px, and a header
// carrying a create button pushed its eye a further ~20px left. jsdom lays nothing
// out, so these pin the declared geometry that produces one column: the shared 16px
// edge, and a slot that reserves the create button's width when there is none.
describe("BranchSection trailing controls", () => {
	const props = {
		label: "Branches",
		count: 3,
		expanded: false,
		ontoggle: vi.fn(),
		groupState: "none" as const,
		ontogglevisibility: vi.fn(),
		children: emptySnippet,
	};

	// The right edge is what puts every row's eye in one column. It is read off the
	// style attribute rather than getComputedStyle because jsdom returns "0" for any
	// padding written as a var(), shorthand or longhand, so toHaveStyle cannot see it.
	it("ends the header at the shared --space-4 edge", () => {
		render(BranchSection, { props });

		expect(
			screen.getByTestId("branch-section-header").getAttribute("style"),
		).toContain("padding: 0 var(--space-4) 0 var(--space-3)");
	});

	// The eye is anchored to the right edge. When a section provides a create button,
	// the create button sits immediately to the left of the visibility toggle.
	it("places the create button before the visibility toggle so the eye is rightmost", () => {
		render(BranchSection, {
			props: { ...props, showCreateButton: true, oncreate: vi.fn() },
		});

		const createBtn = screen.getByTestId("branch-section-create-btn");
		const visibilityBtn = screen.getByTestId("branch-section-visibility-btn");

		expect(createBtn.compareDocumentPosition(visibilityBtn)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	// The Stashes section reuses this component, so a hardcoded label had its create
	// button announcing "Create new branch" to a screen reader.
	it("names the create button after what the section creates", () => {
		render(BranchSection, {
			props: {
				...props,
				label: "Stashes",
				showCreateButton: true,
				createLabel: "Create new stash",
				oncreate: vi.fn(),
			},
		});

		expect(screen.getByLabelText("Create new stash")).toBeInTheDocument();
	});

	it("renders no create button when the section has none", () => {
		render(BranchSection, { props });

		expect(
			screen.queryByTestId("branch-section-create-btn"),
		).not.toBeInTheDocument();
	});
});
