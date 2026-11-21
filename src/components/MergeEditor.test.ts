import { invoke } from "@tauri-apps/api/core";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import {
	beforeEach,
	describe,
	expect,
	it,
	type MockedFunction,
	vi,
} from "vitest";
import {
	conflictRegion as conflict,
	gitMergedRegion,
	makeMergeSides,
	mergedRegion as merged,
} from "../__tests__/helpers/factories.js";
import { createMergePicks } from "../lib/merge-picks.js";
import type { MergeRegion, MergeSides } from "../lib/types.js";
import MergeEditor from "./MergeEditor.svelte";

// Shared Tauri mocks (event, store, dialog, path, menu, etc.)
import "../__tests__/helpers/tauri-mock";

// Re-declare invoke mock locally so vi.mocked() works with hoisting
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

const mockInvoke = vi.mocked(invoke);

type Dialog = typeof import("@tauri-apps/plugin-dialog");

function sidesOf(...regions: MergeRegion[]): MergeSides {
	return { regions };
}

const MERGE_SIDES = makeMergeSides();

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

	describe("when git merged a line only the incoming side changed", () => {
		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				return Promise.resolve(
					sidesOf(
						gitMergedRegion({
							ours: ["a", "b", "c", "d"],
							theirs: ["a", "theirs b", "c", "d"],
							merged: ["a", "theirs b", "c", "d"],
						}),
						conflict(["ours e"], ["theirs e"]),
						merged(""),
					),
				);
			});
		});

		it("outputs the line as git merged it and leaves one conflict to resolve", async () => {
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

			expect(result.value).toBe("a\ntheirs b\nc\nd\n");
			expect(
				screen.getAllByRole("button", { name: /^Take conflict 1 from/ }),
			).toHaveLength(2);
			expect(
				screen.queryAllByRole("button", { name: /^Take conflict 2 from/ }),
			).toEqual([]);
		});

		it("shows each side's own line in its pane beside the merged one", async () => {
			render(MergeEditor, {
				props: {
					repoPath: "/test/repo",
					filePath: "src/main.ts",
					onclose: () => {},
					onresolved: () => {},
				},
			});

			const current = await screen.findByRole("region", {
				name: "Current (Ours)",
			});
			const incoming = screen.getByRole("region", {
				name: "Incoming (Theirs)",
			});

			expect(within(current).getByText("b")).toBeInTheDocument();
			expect(within(current).queryByText("theirs b")).toBeNull();
			expect(within(incoming).getByText("theirs b")).toBeInTheDocument();
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
				return Promise.resolve(
					sidesOf(
						merged("first"),
						conflict(
							["ours one", "ours two", "ours three"],
							["theirs one", "theirs two", "theirs three"],
						),
						merged("last", ""),
					),
				);
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

		it("takes one line for a shift click in a file opened after the click", async () => {
			const view = render(MergeEditor, { props });
			await output();
			await fireEvent.click(line("theirs one"));
			await view.rerender({ filePath: "src/other.ts" });
			const result = await output();
			await waitFor(() => expect(result.value).not.toContain("theirs one"));

			await fireEvent.click(line("theirs three"), {
				shiftKey: true,
				detail: 1,
			});

			expect(result.value).toContain("theirs three");
			expect(result.value).not.toContain("theirs two");
		});

		it("takes one line for a shift click after Reset", async () => {
			render(MergeEditor, { props });
			const result = await output();
			await fireEvent.click(line("theirs one"));
			await fireEvent.click(
				screen.getByRole("button", { name: "Reset merge selections" }),
			);

			await fireEvent.click(line("theirs three"), {
				shiftKey: true,
				detail: 1,
			});

			expect(result.value).toContain("theirs three");
			expect(result.value).not.toContain("theirs two");
		});

		it("keeps the lines taken in a file while another file is open", async () => {
			const view = render(MergeEditor, { props });
			await output();
			await fireEvent.click(line("theirs two"));
			await view.rerender({ filePath: "src/other.ts" });
			await waitFor(async () =>
				expect((await output()).value).not.toContain("theirs two"),
			);

			await view.rerender({ filePath: "src/main.ts" });

			await waitFor(async () =>
				expect((await output()).value).toContain("theirs two"),
			);
		});

		it("keeps the output typed in a file while another file is open", async () => {
			const view = render(MergeEditor, { props });
			await fireEvent.input(await output(), {
				target: { value: "typed by hand" },
			});
			await view.rerender({ filePath: "src/other.ts" });
			await waitFor(async () =>
				expect((await output()).value).not.toContain("typed by hand"),
			);

			await view.rerender({ filePath: "src/main.ts" });

			await waitFor(async () =>
				expect((await output()).value).toBe("typed by hand"),
			);
		});

		it("starts afresh in a file whose sides changed while another file was open", async () => {
			const view = render(MergeEditor, { props });
			await output();
			await fireEvent.click(line("theirs two"));
			await view.rerender({ filePath: "src/other.ts" });
			await waitFor(async () =>
				expect((await output()).value).not.toContain("theirs two"),
			);
			mockInvoke.mockImplementation((cmd: string) =>
				Promise.resolve(
					cmd === "get_merge_sides"
						? sidesOf(
								merged("changed first"),
								conflict(["ours one"], ["theirs one", "theirs two"]),
								merged("last", ""),
							)
						: undefined,
				),
			);

			await view.rerender({ filePath: "src/main.ts" });

			await waitFor(async () =>
				expect((await output()).value).toContain("changed first"),
			);
			expect((await output()).value).not.toContain("theirs two");
		});

		it("keeps the lines taken in a file after the editor closes on it", async () => {
			const picks = createMergePicks();
			const first = render(MergeEditor, { props: { ...props, picks } });
			await output();
			await fireEvent.click(line("theirs two"));
			first.unmount();

			render(MergeEditor, { props: { ...props, picks } });

			await waitFor(async () =>
				expect((await output()).value).toContain("theirs two"),
			);
		});

		it("forgets the lines taken in a file once it is resolved", async () => {
			const picks = createMergePicks();
			const first = render(MergeEditor, { props: { ...props, picks } });
			await output();
			await fireEvent.click(line("theirs two"));
			await fireEvent.click(
				screen.getByRole("button", { name: "Save and Mark Resolved" }),
			);
			await waitFor(() =>
				expect(mockInvoke).toHaveBeenCalledWith(
					"save_merge_result",
					expect.anything(),
				),
			);
			first.unmount();

			render(MergeEditor, { props: { ...props, picks } });

			expect((await output()).value).not.toContain("theirs two");
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

		function header(side: "Current (Ours)" | "Incoming (Theirs)") {
			return screen.getByRole("button", {
				name: `Take conflict 1 from ${side}`,
			});
		}

		function save(): HTMLElement {
			return screen.getByRole("button", { name: "Save and Mark Resolved" });
		}

		it("opens with neither side of a conflict taken", async () => {
			render(MergeEditor, { props });
			const result = await output();

			expect(header("Current (Ours)")).toHaveAttribute("aria-pressed", "false");
			expect(header("Incoming (Theirs)")).toHaveAttribute(
				"aria-pressed",
				"false",
			);
			expect(result.value).toBe("first\nlast\n");
		});

		it("takes only the incoming side when its header is clicked first", async () => {
			render(MergeEditor, { props });
			const result = await output();

			await fireEvent.click(header("Incoming (Theirs)"));

			expect(result.value).toBe(
				"first\ntheirs one\ntheirs two\ntheirs three\nlast\n",
			);
		});

		it("refuses to save while a conflict has no side taken", async () => {
			render(MergeEditor, { props });
			await output();

			expect(save()).toBeDisabled();
			expect(screen.getByText("1 conflict unresolved")).toBeInTheDocument();
		});

		it("saves once every conflict has a side taken", async () => {
			render(MergeEditor, { props });
			await output();

			await fireEvent.click(header("Current (Ours)"));
			await fireEvent.click(save());

			expect(mockInvoke).toHaveBeenCalledWith("save_merge_result", {
				path: "/test/repo",
				filePath: "src/main.ts",
				content: "first\nours one\nours two\nours three\nlast\n",
			});
			expect(screen.queryByText(/unresolved$/)).toBeNull();
		});

		it("saves an edited output whatever is taken", async () => {
			render(MergeEditor, { props });
			const result = await output();

			await fireEvent.input(result, { target: { value: "first\nmine\n" } });

			expect(save()).toBeEnabled();
		});

		it("returns every conflict to unresolved on reset", async () => {
			render(MergeEditor, { props });
			const result = await output();
			await fireEvent.click(header("Incoming (Theirs)"));

			await fireEvent.click(
				screen.getByRole("button", { name: "Reset merge selections" }),
			);

			expect(result.value).toBe("first\nlast\n");
			expect(save()).toBeDisabled();
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

		describe("when the output was typed", () => {
			const typed = "first\nmine\nlast\n";

			let ask: MockedFunction<Dialog["ask"]>;

			beforeEach(async () => {
				ask = vi.mocked((await import("@tauri-apps/plugin-dialog")).ask);
				ask.mockReset();
			});

			async function typeOutput(): Promise<HTMLTextAreaElement> {
				const result = await output();
				await fireEvent.input(result, { target: { value: typed } });
				return result;
			}

			it("replaces the typed output with a take the user confirms", async () => {
				ask.mockResolvedValue(true);
				render(MergeEditor, { props });
				const result = await typeOutput();

				await fireEvent.click(header("Incoming (Theirs)"));

				await waitFor(() =>
					expect(result.value).toBe(
						"first\ntheirs one\ntheirs two\ntheirs three\nlast\n",
					),
				);
			});

			it("keeps the typed output when the user declines a take", async () => {
				ask.mockResolvedValue(false);
				render(MergeEditor, { props });
				const result = await typeOutput();

				await fireEvent.click(line("theirs two"));

				await waitFor(() => expect(ask).toHaveBeenCalled());
				expect(result.value).toBe(typed);
				expect(line("theirs two")).toHaveAttribute("aria-pressed", "false");
			});

			it("keeps the typed output when the user declines a reset", async () => {
				ask.mockResolvedValue(false);
				render(MergeEditor, { props });
				const result = await typeOutput();

				await fireEvent.click(
					screen.getByRole("button", { name: "Reset merge selections" }),
				);

				await waitFor(() => expect(ask).toHaveBeenCalled());
				expect(result.value).toBe(typed);
			});

			it("takes without asking once nothing is typed", async () => {
				render(MergeEditor, { props });
				await output();

				await fireEvent.click(header("Incoming (Theirs)"));

				expect(ask).not.toHaveBeenCalled();
			});
		});
	});

	describe("when the file ends its lines with CRLF", () => {
		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				return Promise.resolve(
					sidesOf(
						merged("first\r"),
						conflict(["ours\r"], ["theirs\r"]),
						merged("last\r", ""),
					),
				);
			});
		});

		it("saves typed output with the file's own line endings", async () => {
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

			await fireEvent.input(result, {
				target: { value: "first\nmine\nlast\n" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Save and Mark Resolved" }),
			);

			expect(mockInvoke).toHaveBeenCalledWith("save_merge_result", {
				path: "/test/repo",
				filePath: "src/main.ts",
				content: "first\r\nmine\r\nlast\r\n",
			});
		});
	});

	describe("when the file holds several conflicts", () => {
		function sides(): MergeSides {
			const context = merged(...Array<string>(100).fill("context"));
			return sidesOf(
				...[1, 2, 3].flatMap((n) => [
					context,
					conflict([`ours ${n}`], [`theirs ${n}`]),
				]),
				merged(""),
			);
		}

		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) =>
				Promise.resolve(cmd === "get_merge_sides" ? sides() : undefined),
			);
		});

		// The editor ignores the scroll events its own scrolling raises until the
		// next frame, so a user's scroll comes after one.
		function nextFrame(): Promise<void> {
			return new Promise((resolve) => requestAnimationFrame(() => resolve()));
		}

		it("counts the conflict the user scrolled back to", async () => {
			render(MergeEditor, {
				props: {
					repoPath: "/test/repo",
					filePath: "src/main.ts",
					onclose: () => {},
					onresolved: () => {},
				},
			});
			const next = await screen.findByRole("button", { name: "Next conflict" });
			await fireEvent.click(next);
			await fireEvent.click(next);
			const output = screen.getByRole("textbox", { name: "Merge output" });
			await nextFrame();

			output.scrollTop = 0;
			await fireEvent.scroll(output);

			expect(await screen.findByText("1/3")).toBeInTheDocument();
			expect(next).toBeEnabled();
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
			[
				"link_conflict",
				"logo.png is a symbolic link on one side, so resolve it outside the merge editor.",
			],
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

		it("starts a retried load unresolved, as the first load does", async () => {
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
			expect(result.value).toBe("line 1\n");
		});
	});

	describe("when one side deleted the conflicting lines", () => {
		const props = {
			repoPath: "/test/repo",
			filePath: "src/main.ts",
			onclose: () => {},
			onresolved: () => {},
		};

		beforeEach(() => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd !== "get_merge_sides") return Promise.resolve(undefined);
				return Promise.resolve(sidesOf(merged("a"), conflict([], ["B"])));
			});
		});

		it("resolves the conflict to the deletion when that side is taken", async () => {
			render(MergeEditor, { props });
			const result = (await screen.findByRole(
				"textbox",
			)) as HTMLTextAreaElement;
			const current = screen.getByRole("button", {
				name: "Take conflict 1 from Current (Ours)",
			});

			await fireEvent.click(current);

			expect(current).toHaveAttribute("aria-pressed", "true");
			expect(result.value).toBe("a");
			expect(
				screen.getByRole("button", { name: "Save and Mark Resolved" }),
			).toBeEnabled();
		});

		it("resolves the conflict to the deletion when all of that side is taken", async () => {
			render(MergeEditor, { props });
			await screen.findByRole("textbox");

			await fireEvent.click(
				screen.getByRole("button", { name: "Take All Current" }),
			);

			expect(
				screen.getByRole("button", { name: "Save and Mark Resolved" }),
			).toBeEnabled();
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
			const replies = new Map<string, (sides: MergeSides) => void>();
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

			replies.get("new.ts")?.(makeMergeSides("new file"));
			replies.get("old.ts")?.(makeMergeSides("old file"));

			expect(
				await screen.findByRole("button", { name: /new file/ }),
			).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /old file/ })).toBeNull();
		});
	});
});
