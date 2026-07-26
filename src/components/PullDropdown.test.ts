import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PullDropdown from "./PullDropdown.svelte";
import "../__tests__/helpers/tauri-mock";
import { safeInvoke } from "../lib/invoke.js";
import { createRemoteState } from "../lib/remote-state.svelte";
import { showToast } from "../lib/toast.svelte.js";

vi.mock("../lib/invoke.js", () => ({ safeInvoke: vi.fn() }));
vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

const mockInvoke = vi.mocked(safeInvoke);
const mockToast = vi.mocked(showToast);

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	mockToast.mockReset();
});

describe("PullDropdown", () => {
	function renderDropdown(disabled = false) {
		return render(PullDropdown, {
			props: {
				repoPath: "/repo",
				disabled,
				remoteState: createRemoteState(),
			},
		});
	}

	it("renders pull/fetch button", () => {
		renderDropdown();
		const button = screen.getByTitle("Pull options");
		expect(button).toBeInTheDocument();
	});

	it("shows dropdown options when clicked", async () => {
		renderDropdown();
		const button = screen.getByTitle("Pull options");
		await fireEvent.click(button);
		expect(screen.getByText("Fetch")).toBeInTheDocument();
		expect(screen.getByText("Fast-forward if possible")).toBeInTheDocument();
		expect(screen.getByText("Fast-forward only")).toBeInTheDocument();
		expect(screen.getByText("Pull (rebase)")).toBeInTheDocument();
	});

	it("closes dropdown on second click", async () => {
		renderDropdown();
		const button = screen.getByTitle("Pull options");
		await fireEvent.click(button);
		expect(screen.getByText("Fetch")).toBeInTheDocument();
		await fireEvent.click(button);
		expect(screen.queryByText("Fetch")).toBeNull();
	});

	it("does not open when disabled", async () => {
		renderDropdown(true);
		const button = screen.getByTitle("Pull options");
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
				props: { repoPath: "/repo", disabled: false, remoteState },
			});
			await fireEvent.click(screen.getByTitle("Pull options"));
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
