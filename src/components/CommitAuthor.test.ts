import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CommitAuthor from "./CommitAuthor.svelte";

const PARENT = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const MERGED = "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3";
const CHILD = "c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function renderAuthor(lineage: { parentOids: string[]; childOids: string[] }) {
	const visited: string[] = [];
	render(CommitAuthor, {
		props: {
			authorName: "Ada",
			authorEmail: "ada@example.com",
			authorTimestamp: 1_700_000_000,
			onnavigate: (oid) => visited.push(oid),
			...lineage,
		},
	});
	return visited;
}

describe("CommitAuthor", () => {
	it("jumps to the parent whose chip is clicked", async () => {
		const visited = renderAuthor({ parentOids: [PARENT], childOids: [] });

		await fireEvent.click(screen.getByRole("button", { name: /a1b2c3d/ }));

		expect(visited).toEqual([PARENT]);
	});

	it("jumps to the child whose chip is clicked", async () => {
		const visited = renderAuthor({ parentOids: [], childOids: [CHILD] });

		await fireEvent.click(screen.getByRole("button", { name: /c7d8e9f/ }));

		expect(visited).toEqual([CHILD]);
	});

	it("draws a chip per parent of a merge", () => {
		renderAuthor({ parentOids: [PARENT, MERGED], childOids: [] });

		expect(screen.getAllByRole("button")).toHaveLength(2);
	});

	it("draws no lineage row for a commit with no parent and no child", () => {
		renderAuthor({ parentOids: [], childOids: [] });

		expect(screen.queryByRole("button")).toBeNull();
	});
});
