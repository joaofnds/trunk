import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import InputDialog from "./InputDialog.svelte";
import "../__tests__/helpers/tauri-mock";

describe("InputDialog", () => {
	const defaultProps = {
		title: "Create Branch",
		fields: [
			{
				key: "name",
				label: "Branch name",
				required: true,
				placeholder: "feature/...",
			},
		],
		onsubmit: vi.fn(),
		oncancel: vi.fn(),
	};

	it("renders title", () => {
		render(InputDialog, { props: defaultProps });
		expect(screen.getByText("Create Branch")).toBeInTheDocument();
	});

	it("renders field labels", () => {
		render(InputDialog, { props: defaultProps });
		expect(screen.getByText(/Branch name/)).toBeInTheDocument();
	});

	it("renders required field marker", () => {
		render(InputDialog, { props: defaultProps });
		expect(screen.getByText("*")).toBeInTheDocument();
	});

	it("disables confirm when required field empty", () => {
		render(InputDialog, { props: defaultProps });
		const confirmBtn = screen.getByText("OK");
		expect(confirmBtn).toBeDisabled();
	});

	it("enables confirm when required field filled", async () => {
		render(InputDialog, { props: defaultProps });
		const input = screen.getByPlaceholderText("feature/...");
		await fireEvent.input(input, { target: { value: "my-branch" } });
		const confirmBtn = screen.getByText("OK");
		expect(confirmBtn).not.toBeDisabled();
	});

	it("calls onsubmit with field values", async () => {
		const onsubmit = vi.fn();
		render(InputDialog, {
			props: { ...defaultProps, onsubmit },
		});
		const input = screen.getByPlaceholderText("feature/...");
		await fireEvent.input(input, { target: { value: "my-branch" } });
		await fireEvent.click(screen.getByText("OK"));
		expect(onsubmit).toHaveBeenCalledWith({ name: "my-branch" });
	});

	it("calls oncancel on Cancel click", async () => {
		const oncancel = vi.fn();
		render(InputDialog, {
			props: { ...defaultProps, oncancel },
		});
		await fireEvent.click(screen.getByText("Cancel"));
		expect(oncancel).toHaveBeenCalled();
	});

	it("calls oncancel when the dialog is cancelled", async () => {
		const oncancel = vi.fn();
		render(InputDialog, { props: { ...defaultProps, oncancel } });

		await fireEvent(screen.getByRole("dialog"), new Event("cancel"));

		expect(oncancel).toHaveBeenCalled();
	});

	it("opens as a modal named by its title", () => {
		render(InputDialog, { props: defaultProps });

		expect(
			screen.getByRole("dialog", { name: "Create Branch" }),
		).toHaveAttribute("open");
	});

	it("calls oncancel on Escape", async () => {
		const oncancel = vi.fn();
		render(InputDialog, {
			props: { ...defaultProps, oncancel },
		});
		const input = screen.getByPlaceholderText("feature/...");
		await fireEvent.keyDown(input, { key: "Escape" });
		expect(oncancel).toHaveBeenCalled();
	});

	it("calls onsubmit on Enter in text input", async () => {
		const onsubmit = vi.fn();
		render(InputDialog, {
			props: { ...defaultProps, onsubmit },
		});
		const input = screen.getByPlaceholderText("feature/...");
		await fireEvent.input(input, { target: { value: "my-branch" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onsubmit).toHaveBeenCalledWith({ name: "my-branch" });
	});

	it("renders custom confirmLabel and cancelLabel", () => {
		render(InputDialog, {
			props: {
				...defaultProps,
				confirmLabel: "Create",
				cancelLabel: "Dismiss",
			},
		});
		expect(screen.getByText("Create")).toBeInTheDocument();
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
	});

	it("draws the confirm as the primary action beside a plain cancel", () => {
		render(InputDialog, { props: defaultProps });

		expect(screen.getByText("OK")).toHaveClass("bg-accent");
		expect(screen.getByText("Cancel")).toHaveClass("border-border");
	});
});
