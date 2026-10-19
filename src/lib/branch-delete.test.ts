import { describe, expect, it } from "vitest";
import { deletePrompt } from "./branch-delete.js";

const PATH = "/work/wt";

describe("deletePrompt", () => {
	it("asks the plain question when no worktree holds the branch", () => {
		expect(deletePrompt("topic", { kind: "not_held" })).toEqual({
			kind: "ask",
			message: "Delete branch 'topic'? This cannot be undone.",
		});
	});

	it("asks the plain question when the main worktree holds it", () => {
		expect(deletePrompt("topic", { kind: "held_by_main" })).toEqual({
			kind: "ask",
			message: "Delete branch 'topic'? This cannot be undone.",
		});
	});

	it("offers to remove the worktree that holds it", () => {
		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: PATH }),
		).toEqual({
			kind: "remove",
			message:
				"'topic' is checked out in the worktree at /work/wt.\n\nRemove that worktree and delete the branch? This cannot be undone.",
			okLabel: "Remove Worktree and Delete",
			removal: { name: "wt", path: PATH, go_ahead: false },
		});
	});

	it("warns with every reason before going ahead", () => {
		const prompt = deletePrompt("topic", {
			kind: "warn",
			name: "wt",
			path: PATH,
			reasons: [
				{ kind: "changes" },
				{ kind: "unchecked" },
				{ kind: "locked", reason: "on a usb stick" },
				{ kind: "locked", reason: null },
				{ kind: "submodules" },
			],
		});

		expect(prompt).toEqual({
			kind: "remove",
			message:
				"'topic' is checked out in the worktree at /work/wt, and removing it may lose work:\n\n" +
				"- It has uncommitted or untracked changes.\n" +
				"- Its changes could not be checked.\n" +
				"- It is locked: on a usb stick\n" +
				"- It is locked.\n" +
				"- It contains submodules, whose commits may exist only there.\n\n" +
				"Remove it anyway and delete the branch? This cannot be undone.",
			okLabel: "Remove Anyway and Delete",
			removal: { name: "wt", path: PATH, go_ahead: true },
		});
	});

	it("flattens line breaks a branch name or a lock reason carries", () => {
		const prompt = deletePrompt("a\u2028b", {
			kind: "warn",
			name: "wt",
			path: PATH,
			reasons: [{ kind: "locked", reason: "x\ny" }],
		});

		expect(prompt.message).toContain("'a�b'");
		expect(prompt.message).toContain("It is locked: x�y");
	});

	it("shows a long worktree path whole and flattens its line breaks", () => {
		const long = `/Users/someone/.t3/worktrees/${"rehearse/".repeat(12)}wt`;
		const broken = "/work/a\u2028b";

		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: long }).message,
		).toContain(` ${long}.`);
		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: broken })
				.message,
		).toContain(" /work/a�b.");
	});

	describe("when removing the worktree is refused", () => {
		it.each([
			[
				"mismatched",
				[PATH],
				"Cannot delete 'topic'. The worktree at /work/wt has it checked out, and its .git file does not point back at this repository, so Trunk will not remove it.",
			],
			[
				"several_holders",
				[PATH, "/work/wt2"],
				"Cannot delete 'topic'. More than one worktree has it checked out:\n\n- /work/wt\n- /work/wt2",
			],
			[
				"open_in_tab",
				[PATH],
				"Cannot delete 'topic' while the worktree at /work/wt, which has it checked out, is open in a tab. Close that tab, then delete again.",
			],
		] as const)("explains a %s refusal", (reason, paths, message) => {
			expect(
				deletePrompt("topic", { kind: "refuse", paths: [...paths], reason }),
			).toEqual({ kind: "refuse", message });
		});
	});
});
