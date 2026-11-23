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
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { createMergePicks } from "../lib/merge-picks.js";
import type { MergeRegion, MergeSides } from "../lib/types.js";
import MergeEditor from "./MergeEditor.svelte";

// Shared Tauri mocks (event, store, dialog, path, menu, etc.)
import "../__tests__/helpers/tauri-mock";

// Re-declare invoke mock locally so vi.mocked() works with hoisting
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

const { copyPath } = vi.hoisted(() => ({ copyPath: vi.fn() }));
vi.mock("../lib/clipboard.js", () => ({ copyText: copyPath }));

const mockInvoke = vi.mocked(invoke);

type Dialog = typeof import("@tauri-apps/plugin-dialog");

function sidesOf(...regions: MergeRegion[]): MergeSides {
	return {
		regions,
		revision: "snapshot",
		base_oid: null,
		current_label: null,
		incoming_label: null,
	};
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

	it("steps between conflicts with brackets only while reading the active merge", async () => {
		const sides = sidesOf(
			conflict(["a"], ["b"]),
			merged("middle"),
			conflict(["c"], ["d"]),
		);
		mockInvoke.mockResolvedValue(sides);
		const props = {
			repoPath: "/repo",
			filePath: "src/f",
			onclose: vi.fn(),
			onresolved: vi.fn(),
			keysActive: true,
		};
		const view = render(MergeEditor, { props });
		const next = await screen.findByRole("button", { name: "Next conflict" });
		const previous = screen.getByRole("button", { name: "Previous conflict" });
		const output = screen.getByRole("textbox", { name: "Merge output" });
		await fireEvent.keyDown(window, { key: "]" });
		expect(next).toBeDisabled();
		expect(previous).toBeEnabled();
		output.focus();
		expect(await fireEvent.keyDown(output, { key: "[" })).toBe(true);
		expect(next).toBeDisabled();
		previous.focus();
		await view.rerender({ keysActive: false });
		expect(await fireEvent.keyDown(previous, { key: "[" })).toBe(true);
		expect(next).toBeDisabled();
		await view.rerender({ keysActive: true });
		expect(await fireEvent.keyDown(window, { key: "[" })).toBe(false);
		expect(screen.getByRole("button", { name: "Next conflict" })).toBeEnabled();
		expect(previous).toBeDisabled();
	});

	it("keeps the draft when toggling shared view settings and wraps the merge base", async () => {
		const prefs = DiffPreferences.defaults();
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "get_merge_sides") return { ...MERGE_SIDES, base_oid: "old" };
			if (cmd === "get_merge_base")
				return { scope: "conflict", text: "base text" };
		});
		render(MergeEditor, {
			props: {
				repoPath: "/repo",
				filePath: "src/f",
				onclose: vi.fn(),
				onresolved: vi.fn(),
				diffPreferences: prefs,
			},
		});
		const output = await screen.findByRole("textbox", { name: "Merge output" });
		await fireEvent.input(output, { target: { value: "[] local draft" } });
		await fireEvent.click(
			screen.getByRole("button", { name: "Toggle word wrap" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Show invisible characters" }),
		);
		expect(output).toHaveAttribute("wrap", "soft");
		expect(
			output.parentElement?.querySelector("pre [data-glyph]"),
		).toBeTruthy();
		expect(prefs.wordWrap).toBe(true);
		expect(prefs.showInvisibles).toBe(true);
		await fireEvent.click(
			screen.getByRole("button", { name: "Show conflicts with context" }),
		);
		expect(
			screen.getByRole("button", { name: "Show full file" }),
		).toBeEnabled();
		await fireEvent.click(
			screen.getByRole("button", { name: "Show merge base for conflict 1" }),
		);
		expect(
			await screen.findByRole("textbox", { name: "Merge base text" }),
		).toHaveAttribute("wrap", "soft");
		expect(output).toHaveValue("[] local draft");
	});

	it("copies the conflicted file's relative and absolute path from the filename menu", async () => {
		render(MergeEditor, {
			props: {
				repoPath: "/repo",
				filePath: "src/theme.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		const path = await screen.findByRole("button", {
			name: "Path actions for src/theme.ts",
		});
		const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
		vi.mocked(MenuItem.new).mockClear();
		vi.mocked(Menu.new).mockClear();
		await fireEvent.contextMenu(path);
		await waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
		const entries = vi.mocked(MenuItem.new).mock.calls.map(([item]) => item);
		expect(entries.map((item) => item?.text)).toEqual([
			"Copy Relative Path",
			"Copy Absolute Path",
		]);
		for (const [index, expected] of [
			"src/theme.ts",
			"/repo/src/theme.ts",
		].entries()) {
			entries[index]?.action?.("copy");
			expect(copyPath).toHaveBeenCalledWith(expected);
		}
		const menu = await vi.mocked(Menu.new).mock.results[0].value;
		await waitFor(() => expect(menu.close).toHaveBeenCalledOnce());
		vi.spyOn(path, "getBoundingClientRect").mockReturnValue(
			new DOMRect(120, 60, 80, 20),
		);
		await fireEvent.click(path, { detail: 0 });
		await waitFor(() =>
			expect(menu.popup).toHaveBeenCalledWith(
				expect.objectContaining({ x: 120, y: 80 }),
			),
		);
	});

	it("expands one context gap on both sides while keeping the exact picked line and complete output", async () => {
		const first = ["one", "two", "three", "four", "five", "six"];
		const middle = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
		const choice = "\tnew value  ";
		mockInvoke.mockImplementation(async (cmd) =>
			cmd === "get_merge_sides"
				? sidesOf(
						gitMergedRegion({
							ours: first,
							theirs: first.slice(2),
							merged: first,
						}),
						conflict([choice], ["incoming"]),
						merged(...middle),
						conflict(["last ours"], ["last theirs"]),
					)
				: undefined,
		);
		render(MergeEditor, {
			props: {
				repoPath: "/repo",
				filePath: "note.txt",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		const current = within(
			await screen.findByRole("region", { name: "Current (Ours)" }),
		);
		const incoming = within(
			screen.getByRole("region", { name: "Incoming (Theirs)" }),
		);
		const show = (name: string) =>
			fireEvent.click(screen.getByRole("button", { name }));
		expect(current.getByText("one")).toBeInTheDocument();

		await show("Show conflicts with context");
		expect(current.queryByText("one")).toBeNull();
		expect(incoming.queryByText("three")).toBeNull();
		await fireEvent.click(
			incoming.getByRole("button", { name: "Expand 1 hidden line" }),
		);
		expect(current.getByText("one")).toBeInTheDocument();
		expect(incoming.getByText("three")).toBeInTheDocument();
		expect(current.queryByText("e")).toBeNull();
		await show("Toggle word wrap");
		await show("Show invisible characters");
		const pick = current.getByRole("button", { name: "7 new value" });
		expect(pick.querySelector("[data-glyph='→']")?.textContent).toBe("\t");
		await fireEvent.click(pick);
		await show("Show full file");
		await show("Show conflicts with context");

		expect(current.queryByText("one")).toBeNull();
		expect(
			current.getByRole("button", { name: "7 new value" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("textbox", { name: "Merge output" })).toHaveValue(
			[...first, choice, ...middle].join("\n"),
		);
	});

	it("highlights each side at its own line number and takes the exact source text", async () => {
		const prefix = '\tconst shortcut = "🧭 Ctrl+';
		const ours = `${prefix}O";`;
		const theirs = `${prefix}K";`;
		const spans = [
			{ start: 0, end: 1, syntax_class: "", emphasized: false },
			{ start: 1, end: 6, syntax_class: "syn-keyword", emphasized: false },
			{ start: 6, end: prefix.length, syntax_class: "", emphasized: false },
			{
				start: prefix.length,
				end: prefix.length + 1,
				syntax_class: "syn-string",
				emphasized: true,
			},
			{
				start: prefix.length + 1,
				end: ours.length,
				syntax_class: "",
				emphasized: false,
			},
		];
		const sides: MergeSides = {
			...sidesOf(
				gitMergedRegion({
					ours: ["// current"],
					theirs: [],
					merged: ["// current"],
				}),
				conflict([ours], [theirs]),
			),
			ours_spans: {
				1: [
					{ start: 0, end: 10, syntax_class: "syn-comment", emphasized: false },
				],
				2: spans,
			},
			theirs_spans: { 1: spans },
		};
		mockInvoke.mockResolvedValue(sides);
		render(MergeEditor, {
			props: {
				repoPath: "/repo",
				filePath: "shortcuts.ts",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		const current = await screen.findByRole("region", {
			name: "Current (Ours)",
		});
		const incoming = screen.getByRole("region", { name: "Incoming (Theirs)" });
		expect(within(current).getByText("// current")).toHaveClass("syn-comment");
		for (const [pane, key, text] of [
			[current, "O", ours],
			[incoming, "K", theirs],
		] as const) {
			expect(within(pane).getByText("const")).toHaveClass("syn-keyword");
			const mark = within(pane).getByRole("mark");
			expect(mark.textContent).toBe(key);
			expect(mark.parentElement?.textContent).toBe(text);
		}
		const row = within(incoming).getByRole("button", { name: /Ctrl\+K/ });
		await fireEvent.click(row);
		expect(row).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("textbox", { name: "Merge output" })).toHaveValue(
			`// current\n${theirs}`,
		);
	});

	it("reads the selected base on request and keeps the draft when the reader closes", async () => {
		const sides = { ...MERGE_SIDES, base_oid: "base-blob" };
		mockInvoke.mockImplementation(async (cmd) =>
			cmd === "get_merge_sides" ? sides : { scope: "file", text: "old line" },
		);
		render(MergeEditor, {
			props: {
				repoPath: "/repo",
				filePath: "src/f",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		const output = await screen.findByRole("textbox", { name: "Merge output" });
		await fireEvent.input(output, { target: { value: "my draft" } });
		expect(mockInvoke.mock.calls.map(([command]) => command)).not.toContain(
			"get_merge_base",
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Show merge base for conflict 1" }),
		);
		const reader = await screen.findByRole("dialog", {
			name: "Merge base · full file",
		});
		expect(within(reader).getByRole("textbox")).toHaveValue("old line");
		await fireEvent.click(
			within(reader).getByRole("button", { name: "Close" }),
		);
		expect(output).toHaveValue("my draft");
		expect(mockInvoke.mock.calls.map(([command]) => command)).not.toContain(
			"save_merge_result",
		);
	});

	it("discards a base reply after the editor moves to another file", async () => {
		let deliver!: (value: unknown) => void;
		mockInvoke.mockImplementation((cmd, args) =>
			cmd === "get_merge_sides"
				? Promise.resolve({
						...MERGE_SIDES,
						base_oid:
							args && "filePath" in args && args.filePath === "first"
								? "blob"
								: null,
					})
				: new Promise((resolve) => {
						deliver = resolve;
					}),
		);
		const props = {
			repoPath: "/repo",
			filePath: "first",
			onclose: vi.fn(),
			onresolved: vi.fn(),
		};
		const editor = render(MergeEditor, { props });
		await fireEvent.click(
			await screen.findByRole("button", {
				name: "Show merge base for conflict 1",
			}),
		);
		await editor.rerender({ ...props, filePath: "second" });
		await screen.findByRole("textbox", { name: "Merge output" });
		deliver({ scope: "conflict", text: "stale" });
		await Promise.resolve();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Show merge base/ }),
		).toBeNull();
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

	it("freezes the approved output while staging and unlocks a failed draft", async () => {
		let reject!: (error: Error) => void;
		mockInvoke.mockImplementation((cmd) =>
			cmd === "get_merge_sides"
				? Promise.resolve(MERGE_SIDES)
				: new Promise((_resolve, rejected) => {
						reject = rejected;
					}),
		);
		render(MergeEditor, {
			props: {
				repoPath: "/r",
				filePath: "a",
				onclose: vi.fn(),
				onresolved: vi.fn(),
			},
		});
		const output = await screen.findByRole("textbox", { name: "Merge output" });
		const take = screen.getByRole("button", { name: "Take All Current" });
		const reset = screen.getByRole("button", {
			name: "Reset merge selections",
		});
		const block = screen.getByRole("button", {
			name: "Take conflict 1 from Current (Ours)",
		});
		await fireEvent.click(take);
		await fireEvent.input(output, { target: { value: "first draft" } });
		await fireEvent.click(
			screen.getByRole("button", { name: "Save and Mark Resolved" }),
		);
		expect(output).toHaveAttribute("readonly");
		expect(take).toBeDisabled();
		expect(reset).toBeDisabled();
		expect(block).toBeDisabled();
		expect(mockInvoke).toHaveBeenCalledWith(
			"save_merge_result",
			expect.objectContaining({ content: "first draft" }),
		);
		reject(new Error("index changed"));
		await waitFor(() => expect(output).not.toHaveAttribute("readonly"));
		expect(output).toHaveValue("first draft");
		expect(take).toBeEnabled();
		expect(reset).toBeEnabled();
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
			expect(
				screen.getByRole("region", { name: "Current (Ours)" }),
			).toBeInTheDocument();
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

	it("reserves the success tone for staging the result", async () => {
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

		expect(
			screen.getByRole("button", { name: "Save and Mark Resolved" }),
		).toHaveClass("bg-success-bg");
		expect(
			screen.getByRole("button", { name: "Take All Current" }),
		).not.toHaveClass("bg-success-bg");
		expect(
			screen.getByRole("button", { name: "Take All Incoming" }),
		).not.toHaveClass("bg-success-bg");
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
				expectedRevision: "snapshot",
				content: "first\nours one\nours two\nours three\nlast\n",
			});
			expect(screen.queryByText(/unresolved$/)).toBeNull();
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

			it.each([true, false])(
				"stages an intentionally empty conflict only on confirmation (%s)",
				async (confirmed) => {
					ask.mockResolvedValue(confirmed);
					render(MergeEditor, { props });
					const result = await output();
					const text = `${result.value}// unrelated comment`;
					await fireEvent.input(result, { target: { value: text } });

					expect(screen.getByText("1 block to review")).toBeInTheDocument();
					await fireEvent.click(
						screen.getByRole("button", { name: "Review and Save…" }),
					);

					await waitFor(() => expect(ask).toHaveBeenCalled());
					const staged = mockInvoke.mock.calls.filter(
						([command]) => command === "save_merge_result",
					);
					expect(staged).toEqual(
						confirmed
							? [
									[
										"save_merge_result",
										{
											path: props.repoPath,
											filePath: props.filePath,
											expectedRevision: "snapshot",
											content: text,
										},
									],
								]
							: [],
					);
					expect(result.value).toBe(text);
				},
			);

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

			await fireEvent.click(
				screen.getByRole("button", { name: "Take All Current" }),
			);
			await fireEvent.input(result, {
				target: { value: "first\nmine\nlast\n" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Save and Mark Resolved" }),
			);

			expect(mockInvoke).toHaveBeenCalledWith("save_merge_result", {
				path: "/test/repo",
				filePath: "src/main.ts",
				expectedRevision: "snapshot",
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
