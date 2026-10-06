import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import BranchChip from "./BranchChip.svelte";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("BranchChip", () => {
	beforeEach(() => {
		vi.mocked(writeText).mockClear();
		_resetToasts();
	});

	it("copies the branch name when pressed", async () => {
		render(BranchChip, { props: { name: "feature/login" } });

		await fireEvent.click(
			screen.getByRole("button", { name: "feature/login" }),
		);

		expect(vi.mocked(writeText)).toHaveBeenCalledWith("feature/login");
		expect(toasts.items).toEqual([
			{
				id: expect.any(Number),
				message: "Copied feature/login",
				kind: "success",
			},
		]);
	});

	it("draws the branch as a ref chip", () => {
		render(BranchChip, { props: { name: "feature/login" } });

		expect(screen.getByRole("button", { name: "feature/login" })).toHaveClass(
			"rounded-full",
			"bg-chip-accent-bg",
			"font-mono",
		);
	});

	it("ends a name too long for its container with an ellipsis", () => {
		render(BranchChip, { props: { name: "feature/login" } });

		expect(screen.getByText("feature/login")).toHaveClass(
			"truncate",
			"min-w-0",
		);
		expect(screen.getByRole("button")).toHaveClass("min-w-0", "max-w-full");
	});

	it("keeps the branch glyph whole while the name gives way", () => {
		render(BranchChip, { props: { name: "feature/login" } });

		expect(screen.getByRole("button").querySelector("svg")).toHaveClass(
			"shrink-0",
		);
	});
});
