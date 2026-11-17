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

	describe("when the incoming side also changed a line the current side kept", () => {
		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				return Promise.resolve({
					base: "a\nb\nc\nd\ne\n",
					ours: "a\nb\nc\nd\nours e\n",
					theirs: "a\ntheirs b\nc\nd\ntheirs e\n",
				});
			});
		});

		it("merges that change into the output and leaves one conflict to resolve", async () => {
			render(MergeEditor, {
				props: {
					repoPath: "/test/repo",
					filePath: "src/main.ts",
					onclose: () => {},
					onresolved: () => {},
				},
			});

			const result = (await screen.findByRole(
				"textbox",
			)) as HTMLTextAreaElement;

			expect(result.value).toBe("a\ntheirs b\nc\nd\nours e\n");
			expect(
				screen.getAllByRole("button", { name: /^Take conflict 1 from/ }),
			).toHaveLength(2);
			expect(
				screen.queryAllByRole("button", { name: /^Take conflict 2 from/ }),
			).toEqual([]);
		});
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
			const incoming = screen.getByRole("button", {
				name: "Take conflict 1 from Incoming (Theirs)",
			});

			await fireEvent.click(incoming);

			expect(result.value).toContain("theirs one\ntheirs two\ntheirs three");
		});

		it("tells each side's conflict header apart and says which side is taken", async () => {
			render(MergeEditor, { props });
			await output();

			const current = screen.getByRole("button", {
				name: "Take conflict 1 from Current (Ours)",
			});
			const incoming = screen.getByRole("button", {
				name: "Take conflict 1 from Incoming (Theirs)",
			});

			expect(current).toHaveAttribute("aria-pressed", "true");
			expect(incoming).toHaveAttribute("aria-pressed", "false");
		});

		it("presses a side's conflict header once that side is taken", async () => {
			render(MergeEditor, { props });
			await output();
			const incoming = screen.getByRole("button", {
				name: "Take conflict 1 from Incoming (Theirs)",
			});

			await fireEvent.click(incoming);

			expect(incoming).toHaveAttribute("aria-pressed", "true");
		});

		it("marks a side's conflict header mixed while only some of its lines are taken", async () => {
			render(MergeEditor, { props });
			await output();

			await fireEvent.click(line("theirs two"));

			expect(
				screen.getByRole("button", {
					name: "Take conflict 1 from Incoming (Theirs)",
				}),
			).toHaveAttribute("aria-pressed", "mixed");
		});

		it("says which lines are taken", async () => {
			render(MergeEditor, { props });
			await output();

			await fireEvent.click(line("theirs two"));

			expect(line("theirs two")).toHaveAttribute("aria-pressed", "true");
			expect(line("theirs one")).toHaveAttribute("aria-pressed", "false");
		});
	});

	describe("when the conflict cannot be loaded", () => {
		function props(onclose = vi.fn()) {
			return {
				repoPath: "/test/repo",
				filePath: "logo.png",
				onclose,
				onresolved: vi.fn(),
			};
		}

		function failLoad(code: string, message: string) {
			mockInvoke.mockImplementation((cmd: string) =>
				cmd === "get_merge_sides"
					? Promise.reject({ code, message })
					: Promise.resolve(undefined),
			);
		}

		it("shows why a binary conflict will not open here", async () => {
			const onclose = vi.fn();
			failLoad(
				"binary_conflict",
				"logo.png is binary, resolve it outside the merge editor.",
			);

			render(MergeEditor, { props: props(onclose) });

			expect(
				await screen.findByText(
					"logo.png is binary, resolve it outside the merge editor.",
				),
			).toBeInTheDocument();
			expect(onclose).not.toHaveBeenCalled();
		});

		it.each([
			[
				"binary_conflict",
				"logo.png is binary, so resolve it outside the merge editor.",
			],
			["delete_conflict", "logo.png was deleted on one side."],
		])(
			"offers no Retry for a %s, which a reload returns again",
			async (code, message) => {
				failLoad(code, message);

				render(MergeEditor, { props: props() });

				expect(await screen.findByText(message)).toBeInTheDocument();
				expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			},
		);

		it("closes when the file is no longer conflicted", async () => {
			const onclose = vi.fn();
			failLoad("not_conflicted", "logo.png has no conflict");

			render(MergeEditor, { props: props(onclose) });

			await waitFor(() => expect(onclose).toHaveBeenCalled());
		});

		it("starts a retried load from the current side, as the first load does", async () => {
			failLoad("git_error", "index locked");
			render(MergeEditor, {
				props: { ...props(), filePath: "src/main.ts" },
			});
			const retry = await screen.findByRole("button", { name: "Retry" });
			mockInvoke.mockImplementation((cmd: string) =>
				cmd === "get_merge_sides"
					? Promise.resolve(MERGE_SIDES)
					: Promise.resolve(undefined),
			);

			await fireEvent.click(retry);

			const result = (await screen.findByRole(
				"textbox",
			)) as HTMLTextAreaElement;
			expect(result.value).toBe(MERGE_SIDES.ours);
		});
	});

	describe("when the file changes before its sides arrive", () => {
		it("ignores the earlier file's refusal", async () => {
			const refusals = new Map<string, (error: unknown) => void>();
			mockInvoke.mockImplementation((cmd: string, args) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				const { filePath } = args as { filePath: string };
				return new Promise((_, reject) => refusals.set(filePath, reject));
			});
			const onclose = vi.fn();
			const view = render(MergeEditor, {
				props: {
					repoPath: "/test/repo",
					filePath: "old.ts",
					onclose,
					onresolved: vi.fn(),
				},
			});
			await view.rerender({ filePath: "new.ts" });

			refusals.get("old.ts")?.({ code: "not_conflicted", message: "resolved" });
			refusals.get("new.ts")?.({ code: "git_error", message: "index locked" });

			expect(await screen.findByText("index locked")).toBeInTheDocument();
			expect(onclose).not.toHaveBeenCalled();
		});

		it("shows the newer file's sides", async () => {
			const replies = new Map<string, (sides: typeof MERGE_SIDES) => void>();
			mockInvoke.mockImplementation((cmd: string, args) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				const { filePath } = args as { filePath: string };
				return new Promise((resolve) => replies.set(filePath, resolve));
			});
			const view = render(MergeEditor, {
				props: {
					repoPath: "/test/repo",
					filePath: "old.ts",
					onclose: vi.fn(),
					onresolved: vi.fn(),
				},
			});
			await view.rerender({ filePath: "new.ts" });

			replies.get("new.ts")?.({ ...MERGE_SIDES, ours: "line 1\nnew file\n" });
			replies.get("old.ts")?.({ ...MERGE_SIDES, ours: "line 1\nold file\n" });

			const result = (await screen.findByRole(
				"textbox",
			)) as HTMLTextAreaElement;
			await waitFor(() => expect(result.value).toBe("line 1\nnew file\n"));
		});
	});
});
