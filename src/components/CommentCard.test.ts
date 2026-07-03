import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { Comment } from "../lib/types.js";
import CommentCard from "./CommentCard.svelte";

describe("CommentCard", () => {
	const comment: Comment = {
		id: "c1",
		text: "needs a null check here",
		anchor: {
			commit_oid: "abc123",
			file_path: "src/foo.ts",
			source: "Diff",
			side: "New",
			start_line: 10,
			end_line: 11,
		},
		cached_excerpt: "+const x = 2;\n const y = 3;",
		commit_oid: "abc123",
	};

	it("keeps the comment body and excerpt code selectable while the gutter stays unselectable", () => {
		const { container } = render(CommentCard, {
			props: { comment, onedit: () => {}, ondelete: () => {} },
		});

		expect(screen.getByText(comment.text)).toHaveClass("select-text");
		expect(screen.getByText("const x = 2;")).toHaveClass("select-text");

		const gutter = container.querySelector(".diff-gutter") as HTMLElement;
		expect(gutter).toHaveClass("select-none");
		expect(gutter).not.toHaveClass("select-text");
	});
});
