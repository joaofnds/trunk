import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PullDropdown from "./PullDropdown.svelte";
import "../__tests__/helpers/tauri-mock";
import { safeInvoke } from "../lib/invoke.js";
import { createRemoteState } from "../lib/remote-state.svelte";
import { showToast } from "../lib/toast.svelte.js";

vi.mock("../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../lib/invoke.js")>()),
	safeInvoke: vi.fn(),
}));
vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

const mockInvoke = vi.mocked(safeInvoke);
const mockToast = vi.mocked(showToast);

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	mockToast.mockReset();
});

describe("PullDropdown", () => {
	function renderDropdown(disabled = false, onpull = () => {}) {
		return render(PullDropdown, {
			props: {
				repoPath: "/repo",
				disabled,
				remoteState: createRemoteState(),
				onpull,
			},
		});
	}

	it("renders the pull button beside its options", () => {
		renderDropdown();

		expect(screen.getByRole("group")).toContainElement(
			screen.getByRole("button", { name: "Pull" }),
		);
		expect(screen.getByRole("group")).toContainElement(
			screen.getByRole("button", { name: "Pull options" }),
		);
	});

	it("runs the pull action from its main button", async () => {
		let pulls = 0;
		renderDropdown(false, () => {
			pulls += 1;
		});

		await fireEvent.click(screen.getByRole("button", { name: "Pull" }));

		expect(pulls).toBe(1);
	});

	it("shows dropdown options when clicked", async () => {
		renderDropdown();
		const button = screen.getByRole("button", { name: "Pull options" });
		await fireEvent.click(button);
		expect(screen.getByText("Fetch")).toBeInTheDocument();
		expect(screen.getByText("Fast-forward if possible")).toBeInTheDocument();
		expect(screen.getByText("Fast-forward only")).toBeInTheDocument();
		expect(screen.getByText("Pull (rebase)")).toBeInTheDocument();
	});

	it("closes dropdown on second click", async () => {
		renderDropdown();
		const button = screen.getByRole("button", { name: "Pull options" });
		await fireEvent.click(button);
		expect(screen.getByText("Fetch")).toBeInTheDocument();
		await fireEvent.click(button);
		expect(screen.queryByText("Fetch")).toBeNull();
	});

	it("does not open when disabled", async () => {
		renderDropdown(true);
		const button = screen.getByRole("button", { name: "Pull options" });
		await fireEvent.click(button);
		expect(screen.queryByText("Fetch")).toBeNull();
	});

	describe("when a remote operation fails", () => {
		it("records the failure on remoteState without an auto-dismissing toast", async () => {
			mockInvoke.mockRejectedValue({
				code: "non_fast_forward",
				message: "rejected",
			});
			const remoteState = createRemoteState();

			render(PullDropdown, {
				props: {
					repoPath: "/repo",
					disabled: false,
					remoteState,
					onpull: () => {},
				},
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Pull options" }),
			);
			await fireEvent.click(screen.getByText("Fetch"));

			await waitFor(() =>
				expect(remoteState.error).toEqual({
					code: "non_fast_forward",
					message: "rejected",
				}),
			);
			expect(mockToast).not.toHaveBeenCalled();
		});
	});
});
