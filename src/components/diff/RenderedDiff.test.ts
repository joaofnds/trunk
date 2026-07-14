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
// Keep the real `isTrunkError` guard — RenderedDiff's catch depends on it.
const safeInvoke = vi.fn();
vi.mock("../../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/invoke.js")>()),
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
			props: { ...baseProps },
		});

		expect(await screen.findByText("Hello")).toBeInTheDocument();
		expect(
			await screen.findByText("Not present at this revision"),
		).toBeInTheDocument();
		expect(container.querySelector(".rendered-error")).toBeNull();
	});

	it("ignores a stale in-flight render when the selected file changes mid-flight", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		safeInvoke.mockImplementation((_cmd: string, args: { filePath: string }) =>
			args.filePath === "A.md" ? first.promise : second.promise,
		);

		const inlineProps = {
			...baseProps,
			layoutMode: "inline" as const,
		};
		// Start on A.md (its render is left slow/in-flight), then switch to B.md.
		const { rerender } = render(RenderedDiff, {
			props: { ...inlineProps, selectedPath: "A.md" },
		});
		await rerender({ ...inlineProps, selectedPath: "B.md" });

		// The fresh (B.md) render resolves first.
		second.resolve("<p>SECOND</p>");
		expect(await screen.findByText("SECOND")).toBeInTheDocument();

		// The stale (A.md) render resolves late — it must NOT overwrite the fresh one.
		first.resolve("<p>FIRST</p>");
		await tick();
		await Promise.resolve();

		expect(screen.queryByText("FIRST")).toBeNull();
		expect(screen.getByText("SECOND")).toBeInTheDocument();
	});
});
