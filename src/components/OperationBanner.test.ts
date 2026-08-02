import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationInfo } from "../lib/types";
import OperationBanner from "./OperationBanner.svelte";

// Tauri mocks declared locally (not the shared side-effect helper) so vi.mock
// hoisting binds the invoke/ask the component sees to these mocks (76-03 decision).
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
	message: vi.fn().mockResolvedValue(undefined),
}));

function makeInfo(overrides: Partial<OperationInfo> = {}): OperationInfo {
	return {
		op_type: overrides.op_type ?? "Merge",
		source_branch: overrides.source_branch ?? "feature",
		target_branch: overrides.target_branch ?? "main",
		progress: overrides.progress ?? null,
		source_color_index: overrides.source_color_index ?? 1,
		target_color_index: overrides.target_color_index ?? 0,
		rebase_message: overrides.rebase_message ?? null,
	};
}

describe("OperationBanner", () => {
	it("shows 'Merging' for merge operations", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Merge" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Merging")).toBeInTheDocument();
	});

	it("shows source and target branch names", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({
					op_type: "Merge",
					source_branch: "feature",
					target_branch: "main",
				}),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("feature")).toBeInTheDocument();
		expect(screen.getByText("main")).toBeInTheDocument();
	});

	it("shows 'Rebasing' for rebase operations", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Rebase" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Rebasing")).toBeInTheDocument();
	});

	it("shows 'onto' for rebase instead of 'into'", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Rebase" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("onto")).toBeInTheDocument();
		expect(screen.queryByText("into")).toBeNull();
	});

	it("shows 'into' for merge instead of 'onto'", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Merge" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("into")).toBeInTheDocument();
		expect(screen.queryByText("onto")).toBeNull();
	});

	it("shows Continue/Skip/Abort buttons for rebase", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Rebase" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Continue")).toBeInTheDocument();
		expect(screen.getByText("Skip")).toBeInTheDocument();
		expect(screen.getByText("Abort")).toBeInTheDocument();
	});

	it("does not show Continue/Skip/Abort for merge", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Merge" }),
				repoPath: "/repo",
			},
		});
		expect(screen.queryByText("Continue")).toBeNull();
		expect(screen.queryByText("Skip")).toBeNull();
		expect(screen.queryByText("Abort")).toBeNull();
	});

	it("shows progress for rebase", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Rebase", progress: "2/5" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("(2/5)")).toBeInTheDocument();
	});

	it("shows cherry-pick label", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "CherryPick" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Cherry-pick in progress")).toBeInTheDocument();
	});
});

describe("OperationBanner revert recovery", () => {
	const mockInvoke = vi.mocked(invoke);
	const mockAsk = vi.mocked(ask);

	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_merge_message")
				return Promise.resolve('Revert "x"\n\nThis reverts commit abc.');
			return Promise.resolve(undefined);
		});
		mockAsk.mockReset();
		mockAsk.mockResolvedValue(true);
	});

	it("renders Continue and Abort buttons for a revert state", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Revert" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Continue")).toBeInTheDocument();
		expect(screen.getByText("Abort")).toBeInTheDocument();
	});

	it("calls revert_abort and onaction when Abort is confirmed", async () => {
		const onaction = vi.fn();
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Revert" }),
				repoPath: "/repo",
				onaction,
			},
		});
		await fireEvent.click(screen.getByText("Abort"));
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("revert_abort", {
				path: "/repo",
			});
		});
		await waitFor(() => {
			expect(onaction).toHaveBeenCalled();
		});
	});

	it("routes Continue through get_merge_message, the editor, then revert_continue", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue("edited revert");
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Revert" }),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});
		await fireEvent.click(screen.getByText("Continue"));
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("get_merge_message", {
				path: "/repo",
			});
		});
		expect(onopenmessageeditor).toHaveBeenCalledWith(
			'Revert "x"\n\nThis reverts commit abc.',
			"Revert commit message",
		);
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("revert_continue", {
				path: "/repo",
				message: "edited revert",
			});
		});
	});

	it("makes no revert_continue commit when the editor is cancelled", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue(null);
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Revert" }),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});
		await fireEvent.click(screen.getByText("Continue"));
		await waitFor(() => {
			expect(onopenmessageeditor).toHaveBeenCalled();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"revert_continue",
			expect.anything(),
		);
	});

	it("does not wire a merge-continue editor button for a merge state", () => {
		const onopenmessageeditor = vi.fn();
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "Merge" }),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});
		expect(screen.queryByText("Continue")).toBeNull();
		expect(screen.queryByText("Abort")).toBeNull();
	});
});

// A CherryPick state rendered a label and no buttons, so a conflicted
// cherry-pick had no exit inside the app. This is the same trap the revert
// recovery above was written to close.
describe("OperationBanner cherry-pick recovery", () => {
	const mockInvoke = vi.mocked(invoke);
	const mockAsk = vi.mocked(ask);

	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_merge_message") return Promise.resolve("Side change\n");
			return Promise.resolve(undefined);
		});
		mockAsk.mockReset();
		mockAsk.mockResolvedValue(true);
	});

	it("renders Continue and Abort buttons for a cherry-pick state", () => {
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "CherryPick" }),
				repoPath: "/repo",
			},
		});
		expect(screen.getByText("Continue")).toBeInTheDocument();
		expect(screen.getByText("Abort")).toBeInTheDocument();
	});

	it("calls cherry_pick_abort and onaction when Abort is confirmed", async () => {
		const onaction = vi.fn();
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "CherryPick" }),
				repoPath: "/repo",
				onaction,
			},
		});
		await fireEvent.click(screen.getByText("Abort"));
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("cherry_pick_abort", {
				path: "/repo",
			});
		});
		await waitFor(() => {
			expect(onaction).toHaveBeenCalled();
		});
	});

	it("routes Continue through get_merge_message, the editor, then cherry_pick_continue", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue("edited pick");
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "CherryPick" }),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});
		await fireEvent.click(screen.getByText("Continue"));
		await waitFor(() => {
			expect(onopenmessageeditor).toHaveBeenCalledWith(
				"Side change\n",
				"Cherry-pick commit message",
			);
		});
		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("cherry_pick_continue", {
				path: "/repo",
				message: "edited pick",
			});
		});
	});

	it("makes no commit when the editor is cancelled", async () => {
		const onopenmessageeditor = vi.fn().mockResolvedValue(null);
		render(OperationBanner, {
			props: {
				info: makeInfo({ op_type: "CherryPick" }),
				repoPath: "/repo",
				onopenmessageeditor,
			},
		});
		await fireEvent.click(screen.getByText("Continue"));
		await waitFor(() => {
			expect(onopenmessageeditor).toHaveBeenCalled();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"cherry_pick_continue",
			expect.anything(),
		);
	});
});
