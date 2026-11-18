import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

	it("closes the menu on Escape", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));

		await fireEvent.keyDown(document.body, { key: "Escape" });

		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("keeps an Escape that closes the menu from reaching the view behind it", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));
		const reachedBehind = escapeSeenBehind();

		await fireEvent.keyDown(document.body, { key: "Escape" });

		expect(reachedBehind()).toBe(false);
	});

	it("returns focus to the options button when Escape closes the menu from an option", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));
		const option = screen.getAllByRole("menuitem")[0];
		option.focus();

		await fireEvent.keyDown(option, { key: "Escape" });

		expect(screen.getByRole("button", { name: "Pull options" })).toHaveFocus();
	});

	it("leaves focus where it was when Escape closes the menu from outside it", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));

		await fireEvent.keyDown(document.body, { key: "Escape" });

		expect(
			screen.getByRole("button", { name: "Pull options" }),
		).not.toHaveFocus();
	});

	it("leaves other keys to the app while the menu is open", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));

		await fireEvent.keyDown(document.body, { key: "Tab" });

		expect(screen.getByRole("menu")).toBeInTheDocument();
	});

	it("leaves an Escape typed in a field to the field", async () => {
		renderDropdown();
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));
		const field = document.createElement("input");
		document.body.append(field);
		onTestFinished(() => field.remove());
		field.focus();

		await fireEvent.keyDown(field, { key: "Escape" });

		expect(screen.getByRole("menu")).toBeInTheDocument();
	});

	it("leaves an Escape to the view behind it while the menu is closed", async () => {
		renderDropdown();
		const reachedBehind = escapeSeenBehind();

		await fireEvent.keyDown(document.body, { key: "Escape" });

		expect(reachedBehind()).toBe(true);
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

/** Whether an Escape reached the repository view's window listener unclaimed,
 *  which is when that view closes the open diff. */
function escapeSeenBehind(): () => boolean {
	let seen = false;
	const listener = (event: KeyboardEvent) => {
		if (event.key === "Escape" && !event.defaultPrevented) seen = true;
	};
	window.addEventListener("keydown", listener);
	onTestFinished(() => window.removeEventListener("keydown", listener));

	return () => seen;
}
