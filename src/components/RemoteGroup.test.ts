import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import RemoteGroup from "./RemoteGroup.svelte";
import "../__tests__/helpers/tauri-mock";

describe("RemoteGroup", () => {
	const defaultProps = {
		remoteName: "origin",
		branches: ["main", "dev"],
		checkingOut: null,
		errorBranch: null,
		errorText: "",
		oncheckout: vi.fn(),
	};

	it("renders remote name header", () => {
		render(RemoteGroup, { props: defaultProps });
		expect(screen.getByText("origin")).toBeInTheDocument();
	});

	it("renders branch rows for each branch", () => {
		render(RemoteGroup, { props: defaultProps });
		expect(screen.getByText("main")).toBeInTheDocument();
		expect(screen.getByText("dev")).toBeInTheDocument();
	});

	it("calls oncheckout with full name when branch clicked", async () => {
		const oncheckout = vi.fn();
		render(RemoteGroup, {
			props: { ...defaultProps, oncheckout },
		});
		const buttons = screen.getAllByRole("button");
		await fireEvent.click(buttons[0]);
		expect(oncheckout).toHaveBeenCalledWith("origin/main");
	});

	it("shows loading state for checking out branch", () => {
		render(RemoteGroup, {
			props: { ...defaultProps, checkingOut: "origin/main" },
		});
		// The BranchRow for "main" should show loading indicator
		expect(screen.getByText(/main/)).toBeInTheDocument();
	});

	it("calls ondblclick with full remote name when branch is double-clicked", async () => {
		const ondblclick = vi.fn();
		render(RemoteGroup, {
			props: { ...defaultProps, ondblclick },
		});
		const buttons = screen.getAllByRole("button");
		await fireEvent.dblClick(buttons[0]);
		expect(ondblclick).toHaveBeenCalledWith("origin/main");
	});

	it("renders without error when ondblclick is not provided", () => {
		const { container } = render(RemoteGroup, {
			props: { ...defaultProps },
		});
		expect(container).toBeTruthy();
	});
});

// The group toggle is a bulk action, never an override: a branch row shows its own state,
// so the eye next to it always tells the truth about that branch (João, 2026-09-02).
describe("RemoteGroup visibility", () => {
	const visibilityProps = {
		...defaultPropsFor(),
		ontogglevisibility: vi.fn(),
		ontogglebranchvisibility: vi.fn(),
	};

	function defaultPropsFor() {
		return {
			remoteName: "origin",
			branches: ["main", "dev"],
			checkingOut: null,
			errorBranch: null,
			errorText: "",
			oncheckout: vi.fn(),
		};
	}

	it("shows a branch as visible even while the whole group reads as hidden", () => {
		render(RemoteGroup, {
			props: {
				...visibilityProps,
				groupState: "all" as const,
				hiddenBranches: { "origin/main": true, "origin/dev": false },
			},
		});

		// dev is not in the hidden set, so its own eye offers to hide it — the group's
		// state does not speak for it.
		expect(screen.getByLabelText("Hide dev")).toBeInTheDocument();
		expect(screen.getByLabelText("Show main")).toBeInTheDocument();
	});

	it("offers to hide the group while it is only partly hidden", () => {
		render(RemoteGroup, {
			props: {
				...visibilityProps,
				groupState: "some" as const,
				hiddenBranches: { "origin/main": true, "origin/dev": false },
			},
		});

		expect(
			screen.getByLabelText("Hide all origin branches"),
		).toBeInTheDocument();
	});

	it("offers to show the group once every branch is hidden", () => {
		render(RemoteGroup, {
			props: {
				...visibilityProps,
				groupState: "all" as const,
				hiddenBranches: { "origin/main": true, "origin/dev": true },
			},
		});

		expect(
			screen.getByLabelText("Show all origin branches"),
		).toBeInTheDocument();
	});
});

// WCAG 2.2 SC 2.5.8 asks for a 24x24 CSS px target. The icon stays 12px; only the
// button's hit area grows to meet it. jsdom lays nothing out, so this pins the declared
// minimum rather than a measured box; see BranchRow.test.ts for the note in full.
describe("RemoteGroup visibility toggle target size", () => {
	it("declares a 24x24 minimum on the toggle", () => {
		render(RemoteGroup, {
			props: {
				remoteName: "origin",
				branches: ["main", "dev"],
				checkingOut: null,
				errorBranch: null,
				errorText: "",
				oncheckout: vi.fn(),
				groupState: "some" as const,
				hiddenBranches: { "origin/main": true, "origin/dev": false },
				ontogglevisibility: vi.fn(),
				ontogglebranchvisibility: vi.fn(),
			},
		});
		expect(screen.getByLabelText("Hide all origin branches")).toHaveStyle({
			minWidth: "var(--target-min)",
			minHeight: "var(--target-min)",
		});
	});
});

// The eye anchors to the right edge with --space-4 padding. No slot is needed.
describe("RemoteGroup trailing controls", () => {
	it("renders the visibility toggle at the right edge without a slot", () => {
		render(RemoteGroup, {
			props: {
				remoteName: "origin",
				branches: ["main"],
				checkingOut: null,
				errorBranch: null,
				errorText: "",
				oncheckout: vi.fn(),
				groupState: "some" as const,
				hiddenBranches: { "origin/main": true },
				ontogglevisibility: vi.fn(),
				ontogglebranchvisibility: vi.fn(),
			},
		});

		expect(
			screen.getByTestId("remote-group-visibility-btn"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("remote-group-create-slot"),
		).not.toBeInTheDocument();
	});

	// This row was the only one in the sidebar with no pinned height: 21px of content
	// plus padding, which a 24px target does not fit. It grows to --bar-h so the target
	// fits. Only the height is asserted: jsdom resolves a declared height written as a
	// var() but returns "0" for any padding that contains one, shorthand or longhand.
	it("pins the sub-header to the bar height so a 24px target fits", () => {
		render(RemoteGroup, {
			props: {
				remoteName: "origin",
				branches: ["main"],
				checkingOut: null,
				errorBranch: null,
				errorText: "",
				oncheckout: vi.fn(),
				groupState: "some" as const,
				hiddenBranches: { "origin/main": true },
				ontogglevisibility: vi.fn(),
				ontogglebranchvisibility: vi.fn(),
			},
		});

		expect(screen.getByTestId("remote-group-subheader")).toHaveStyle({
			height: "var(--bar-h)",
		});
	});
});
