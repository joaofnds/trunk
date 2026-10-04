import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MergeEditor from "./MergeEditor.svelte";

// Shared Tauri mocks (event, store, dialog, path, menu, etc.)
import "../__tests__/helpers/tauri-mock";

// Re-declare invoke mock locally so vi.mocked() works with hoisting
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

const mockInvoke = vi.mocked(invoke);

const MERGE_SIDES = {
	base: "line 1\ncommon line\n",
	ours: "line 1\nour change\n",
	theirs: "line 1\ntheir change\n",
};

describe("MergeEditor", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_merge_sides") return Promise.resolve(MERGE_SIDES);
			if (cmd === "write_merge_result") return Promise.resolve(undefined);
			return Promise.resolve(undefined);
		});
	});

	it("renders without crashing", async () => {
		const { container } = render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		expect(container).toBeTruthy();
	});

	it("renders loading state initially", () => {
		// Use a mock that never resolves to keep the loading state
		mockInvoke.mockImplementation(() => new Promise(() => {}));
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		expect(screen.getByText("Loading merge editor...")).toBeInTheDocument();
	});

	it("renders panel headers after loading", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByText("Current (Ours)")).toBeInTheDocument();
		});
		expect(screen.getByText("Output")).toBeInTheDocument();
	});

	it("renders Save and Mark Resolved button", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByText("Save and Mark Resolved")).toBeInTheDocument();
		});
	});

	it("renders close button with aria label", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByLabelText("Close merge editor")).toBeInTheDocument();
		});
	});

	it("calls onclose when close button clicked", async () => {
		const onclose = vi.fn();
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose,
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByLabelText("Close merge editor")).toBeInTheDocument();
		});
		await fireEvent.click(screen.getByLabelText("Close merge editor"));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it("paints every resolving action in the success tone", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByText("Save and Mark Resolved")).toBeInTheDocument();
		});

		for (const label of [
			"Take All Current",
			"Take All Incoming",
			"Save and Mark Resolved",
		]) {
			expect(screen.getByRole("button", { name: label })).toHaveClass(
				"bg-success-bg",
			);
		}
	});

	it("draws the conflict chrome as small icon controls", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/test/repo",
				filePath: "src/main.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		await waitFor(() => {
			expect(screen.getByLabelText("Close merge editor")).toBeInTheDocument();
		});

		for (const label of ["Reset merge selections", "Close merge editor"]) {
			expect(screen.getByLabelText(label)).toHaveClass("w-control-sm");
		}
	});

	describe("when a conflict spans several lines", () => {
		const props = {
			repoPath: "/test/repo",
			filePath: "src/main.ts",
			onclose: () => {},
			onresolved: () => {},
		};

		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				return Promise.resolve({
					base: "first\nold one\nold two\nold three\nlast\n",
					ours: "first\nours one\nours two\nours three\nlast\n",
					theirs: "first\ntheirs one\ntheirs two\ntheirs three\nlast\n",
				});
			});
		});

		async function output(): Promise<HTMLTextAreaElement> {
			return (await screen.findByRole("textbox")) as HTMLTextAreaElement;
		}

		function line(text: string): HTMLElement {
			return screen.getByRole("button", { name: new RegExp(text) });
		}

		it("takes an incoming line when it is clicked", async () => {
			render(MergeEditor, { props });
			const result = await output();

			await fireEvent.click(line("theirs two"));

			expect(result.value).toContain("theirs two");
			expect(result.value).not.toContain("theirs one");
		});

		it("takes the run of lines between a click and a shift click", async () => {
			render(MergeEditor, { props });
			const result = await output();

			await fireEvent.click(line("theirs one"));
			await fireEvent.click(line("theirs three"), {
				shiftKey: true,
				detail: 1,
			});

			expect(result.value).toContain("theirs one\ntheirs two\ntheirs three");
		});

		it("takes one line when a key press with Shift held activates it", async () => {
			render(MergeEditor, { props });
			const result = await output();

			await fireEvent.click(line("theirs one"));
			await fireEvent.click(line("theirs three"), {
				shiftKey: true,
				detail: 0,
			});

			expect(result.value).toContain("theirs three");
			expect(result.value).not.toContain("theirs two");
		});

		it("takes every line of a side when its conflict header is clicked", async () => {
			render(MergeEditor, { props });
			const result = await output();
			const [, incoming] = screen.getAllByRole("button", {
				name: "Conflict 1",
			});

			await fireEvent.click(incoming);

			expect(result.value).toContain("theirs one\ntheirs two\ntheirs three");
		});
	});
});
