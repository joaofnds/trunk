import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchChip from "./BranchChip.svelte";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("BranchChip", () => {
	beforeEach(() => {
		vi.mocked(writeText).mockClear();
	});

	it("copies the branch name when pressed", async () => {
		render(BranchChip, { props: { name: "feature/login" } });

		await fireEvent.click(
			screen.getByRole("button", { name: "feature/login" }),
		);

		expect(vi.mocked(writeText)).toHaveBeenCalledWith("feature/login");
	});

	it("draws the branch as a ref chip", () => {
		render(BranchChip, { props: { name: "feature/login" } });

		expect(screen.getByRole("button", { name: "feature/login" })).toHaveClass(
			"rounded-full",
			"bg-chip-accent-bg",
			"font-mono",
		);
	});

	it("marks a branch with the branch glyph", () => {
		const { container } = render(BranchChip, { props: { name: "main" } });

		expect(container.querySelector(".lucide-git-branch")).not.toBeNull();
	});

	it("marks a lane-toned branch with the graph's local-branch glyph", () => {
		const { container } = render(BranchChip, {
			props: { name: "main", tone: "lane" },
		});

		expect(container.querySelector(".lucide-laptop")).not.toBeNull();
		expect(container.querySelector(".lucide-git-branch")).toBeNull();
	});

	it("lets a name too long for its row end in an ellipsis", () => {
		render(BranchChip, { props: { name: "feature/login" } });

		expect(screen.getByRole("button")).toHaveClass("chip-truncate");
	});
});
