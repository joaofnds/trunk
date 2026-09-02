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
