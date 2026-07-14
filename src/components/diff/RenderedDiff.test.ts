import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { FileDiff } from "../../lib/types.js";
import RenderedDiff from "./RenderedDiff.svelte";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// Mock the shared IPC helper (not `invoke`) per the project's test convention.
const safeInvoke = vi.fn();
vi.mock("../../lib/invoke.js", () => ({
	safeInvoke: (cmd: string, args: Record<string, unknown>) =>
		safeInvoke(cmd, args),
}));

const baseProps = {
	layoutMode: "split" as const,
	selectedPath: "README.md",
	diffKind: "unstaged" as const,
	commitOid: "",
	repoPath: "/repo",
	commitDetail: null,
	fileDiffs: [] as FileDiff[],
};

describe("RenderedDiff", () => {
	it("renders the present side and a placeholder for the absent side (added file, full mode)", async () => {
		safeInvoke.mockImplementation(
			(_cmd: string, args: { rev: { type: string } }) => {
				// The "before" side of an added file (HEAD) has no blob → not_found.
				if (args.rev.type === "head") {
					return Promise.reject({ code: "not_found", message: "not in tree" });
				}
				return Promise.resolve("<h1>Hello</h1>");
			},
		);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, contentMode: "full" },
		});

		expect(await screen.findByText("Hello")).toBeInTheDocument();
		expect(
			await screen.findByText("Not present at this revision"),
		).toBeInTheDocument();
		expect(container.querySelector(".rendered-error")).toBeNull();
	});

	it("renders only the changed hunks' markdown in hunk mode", async () => {
		safeInvoke.mockImplementation((cmd: string, args: { text?: string }) => {
			// Hunk mode must call the text renderer with the extracted hunk content.
			expect(cmd).toBe("render_markdown_text");
			return Promise.resolve(`<rendered>${args.text}</rendered>`);
		});

		const fileDiffs: FileDiff[] = [
			{
				path: "README.md",
				status: "Modified",
				is_binary: false,
				hunks: [
					{
						header: "@@ -1 +1 @@",
						old_start: 1,
						old_lines: 1,
						new_start: 1,
						new_lines: 2,
						lines: [
							{
								origin: "Context",
								content: "# Title\n",
								old_lineno: 1,
								new_lineno: 1,
								spans: [],
							},
							{
								origin: "Add",
								content: "new line\n",
								old_lineno: null,
								new_lineno: 2,
								spans: [],
							},
						],
					},
				],
			},
		];

		render(RenderedDiff, {
			props: { ...baseProps, contentMode: "hunk", fileDiffs },
		});

		// The "after" side keeps context + added lines.
		expect(await screen.findByText(/# Title\s+new line/)).toBeInTheDocument();
		expect(safeInvoke).toHaveBeenCalledWith(
			"render_markdown_text",
			expect.objectContaining({ text: "# Title\nnew line\n" }),
		);
	});

	it("ignores a stale in-flight render when the mode is toggled mid-flight", async () => {
		const fileDiffs: FileDiff[] = [
			{
				path: "README.md",
				status: "Modified",
				is_binary: false,
				hunks: [
					{
						header: "@@",
						old_start: 1,
						old_lines: 1,
						new_start: 1,
						new_lines: 1,
						lines: [
							{
								origin: "Add",
								content: "changed\n",
								old_lineno: null,
								new_lineno: 1,
								spans: [],
							},
						],
					},
				],
			},
		];
		const full = deferred<string>();
		const hunk = deferred<string>();
		safeInvoke.mockImplementation((cmd: string) =>
			cmd === "render_markdown_text" ? hunk.promise : full.promise,
		);

		const inlineProps = {
			...baseProps,
			layoutMode: "inline" as const,
			fileDiffs,
		};
		// Start in full mode (its render is left slow/in-flight), then toggle to hunk.
		const { rerender } = render(RenderedDiff, {
			props: { ...inlineProps, contentMode: "full" },
		});
		await rerender({ ...inlineProps, contentMode: "hunk" });

		// The fresh (hunk) render resolves first.
		hunk.resolve("<p>HUNK</p>");
		expect(await screen.findByText("HUNK")).toBeInTheDocument();

		// The stale (full) render resolves late — it must NOT overwrite the fresh one.
		full.resolve("<p>FULL</p>");
		await tick();
		await Promise.resolve();

		expect(screen.queryByText("FULL")).toBeNull();
		expect(screen.getByText("HUNK")).toBeInTheDocument();
	});
});
