import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SearchBar from "./SearchBar.svelte";
import "../__tests__/helpers/tauri-mock";

describe("SearchBar", () => {
	const defaultProps = {
		query: "",
		currentIndex: 0,
		totalMatches: 0,
		onquerychange: vi.fn(),
		onnext: vi.fn(),
		onprev: vi.fn(),
		onclose: vi.fn(),
	};

	it("renders input with placeholder", () => {
		render(SearchBar, { props: defaultProps });
		expect(screen.getByPlaceholderText(/Search commits/)).toBeInTheDocument();
	});

	it("shows match count when query has matches", () => {
		render(SearchBar, {
			props: {
				...defaultProps,
				query: "fix",
				totalMatches: 5,
				currentIndex: 2,
			},
		});
		expect(screen.getByText("3 of 5")).toBeInTheDocument();
	});

	it("shows '0 matches' when query has no results", () => {
		render(SearchBar, {
			props: { ...defaultProps, query: "xyz", totalMatches: 0 },
		});
		expect(screen.getByText("0 matches")).toBeInTheDocument();
	});

	it("hides match count when query empty", () => {
		render(SearchBar, {
			props: { ...defaultProps, query: "" },
		});
		expect(screen.queryByText("0 matches")).toBeNull();
		expect(screen.queryByText(/of/)).toBeNull();
	});

	it("calls onquerychange when typing", async () => {
		const onquerychange = vi.fn();
		render(SearchBar, {
			props: { ...defaultProps, onquerychange },
		});
		const input = screen.getByPlaceholderText(/Search commits/);
		await fireEvent.input(input, { target: { value: "hello" } });
		expect(onquerychange).toHaveBeenCalled();
	});

	it("calls onnext on Enter", async () => {
		const onnext = vi.fn();
		render(SearchBar, {
			props: { ...defaultProps, onnext },
		});
		const input = screen.getByPlaceholderText(/Search commits/);
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onnext).toHaveBeenCalled();
	});

	it("calls onprev on Shift+Enter", async () => {
		const onprev = vi.fn();
		render(SearchBar, {
			props: { ...defaultProps, onprev },
		});
		const input = screen.getByPlaceholderText(/Search commits/);
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(onprev).toHaveBeenCalled();
	});

	it("calls onclose on Escape", async () => {
		const onclose = vi.fn();
		render(SearchBar, {
			props: { ...defaultProps, onclose },
		});
		const input = screen.getByPlaceholderText(/Search commits/);
		await fireEvent.keyDown(input, { key: "Escape" });
		expect(onclose).toHaveBeenCalled();
	});

	it("draws its stepping and close as small ghost icon controls", () => {
		render(SearchBar, { props: defaultProps });

		for (const name of ["Previous match", "Next match", "Close search"]) {
			expect(screen.getByLabelText(name)).toHaveClass(
				"w-control-sm",
				"bg-transparent",
			);
		}
	});

	it("disables nav buttons when totalMatches=0", () => {
		render(SearchBar, {
			props: { ...defaultProps, totalMatches: 0 },
		});
		const buttons = screen.getAllByRole("button");
		// prev and next buttons (not close) should be disabled
		const disabledButtons = buttons.filter((b) => b.hasAttribute("disabled"));
		expect(disabledButtons.length).toBeGreaterThanOrEqual(2);
	});
});
