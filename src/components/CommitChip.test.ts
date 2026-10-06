import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommitChip from "./CommitChip.svelte";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

const OID = "7d6008b2c4e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7";

describe("CommitChip", () => {
	beforeEach(() => {
		vi.mocked(writeText).mockClear();
	});

	it("copies the full SHA when pressed", async () => {
		render(CommitChip, { props: { oid: OID } });

		await fireEvent.click(screen.getByRole("button", { name: "7d6008b" }));

		expect(vi.mocked(writeText)).toHaveBeenCalledWith(OID);
	});

	it("draws the commit as a ref chip", () => {
		render(CommitChip, { props: { oid: OID } });

		expect(screen.getByRole("button", { name: "7d6008b" })).toHaveClass(
			"rounded-full",
			"bg-chip-accent-bg",
			"font-mono",
		);
	});
});
