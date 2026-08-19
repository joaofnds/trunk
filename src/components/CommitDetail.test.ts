import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitDetail, FileDiff } from "../lib/types.js";
import CommitDetailComponent from "./CommitDetail.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

const detail: CommitDetail = {
	oid: "abc123def456",
	short_oid: "abc123d",
	summary: "fix: null check",
	body: null,
	author_name: "Test User",
	author_email: "test@test.com",
	author_timestamp: 1700000000,
	committer_name: "Test User",
	committer_email: "test@test.com",
	committer_timestamp: 1700000000,
	parent_oids: ["parent1abc"],
};

const fileDiffs: FileDiff[] = [
	{
		path: "src/main.ts",
		status: "Modified",
		is_binary: false,
		hunks: [],
	},
	{
		path: "src/lib/utils.ts",
		status: "Added",
		is_binary: false,
		hunks: [],
	},
];

describe("CommitDetail", () => {
	it("renders commit summary", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(screen.getByText("fix: null check")).toBeInTheDocument();
	});

	it("renders author name and email", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(screen.getByText("Test User")).toBeInTheDocument();
		expect(screen.getByText("test@test.com")).toBeInTheDocument();
	});

	it("renders parent OIDs", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		// parent_oids[0].slice(0,7) = "parent1"
		expect(screen.getByText("parent1")).toBeInTheDocument();
	});

	it("navigates to the parent when the parent chip is clicked", async () => {
		const onnavigate = vi.fn();
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
				onnavigate,
			},
		});

		await fireEvent.click(screen.getByText("parent1"));

		expect(onnavigate).toHaveBeenCalledWith("parent1abc");
	});

	describe("pager", () => {
		const nav = {
			index: 12,
			total: 340,
			hasMore: true,
			newerOid: "newerOid123",
			olderOid: "olderOid456",
			childOids: [],
		};

		it("shows the position readout with a + when hasMore", () => {
			render(CommitDetailComponent, {
				props: {
					commitDetail: detail,
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
					nav,
				},
			});
			expect(screen.getByText("12 / 340+")).toBeInTheDocument();
		});

		it("navigates newer/older from the chevrons", async () => {
			const onnavigate = vi.fn();
			render(CommitDetailComponent, {
				props: {
					commitDetail: detail,
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
					nav,
					onnavigate,
				},
			});

			await fireEvent.click(screen.getByLabelText("Go to newer commit"));
			expect(onnavigate).toHaveBeenCalledWith("newerOid123");

			await fireEvent.click(screen.getByLabelText("Go to older commit"));
			expect(onnavigate).toHaveBeenCalledWith("olderOid456");
		});

		it("disables the newer chevron at the top of history", () => {
			render(CommitDetailComponent, {
				props: {
					commitDetail: detail,
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
					nav: { ...nav, newerOid: null },
				},
			});
			expect(screen.getByLabelText("Go to newer commit")).toBeDisabled();
		});

		it("renders child chips that navigate", async () => {
			const onnavigate = vi.fn();
			render(CommitDetailComponent, {
				props: {
					commitDetail: detail,
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
					nav: { ...nav, childOids: ["childOid789"] },
					onnavigate,
				},
			});

			await fireEvent.click(screen.getByText("childOi"));
			expect(onnavigate).toHaveBeenCalledWith("childOid789");
		});
	});

	it("renders short oid in toolbar", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(
			screen.getByText((_, el) => el?.textContent === "commit: abc123d"),
		).toBeInTheDocument();
	});

	it("renders file count", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(screen.getByText("2 files changed")).toBeInTheDocument();
	});

	it("calls onclose when close button clicked", async () => {
		const onclose = vi.fn();
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose,
			},
		});
		const closeBtn = screen.getByLabelText("Close commit detail");
		await fireEvent.click(closeBtn);
		expect(onclose).toHaveBeenCalledOnce();
	});

	describe("clicking a SHA", () => {
		beforeEach(() => {
			vi.mocked(writeText).mockClear();
			vi.mocked(writeText).mockResolvedValue(undefined);
		});

		it("copies the full commit oid from the toolbar SHA", async () => {
			render(CommitDetailComponent, {
				props: {
					commitDetail: detail,
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
				},
			});

			await fireEvent.click(screen.getByText("abc123d"));

			expect(vi.mocked(writeText)).toHaveBeenCalledWith("abc123def456");
		});
	});

	it("renders commit body when present", () => {
		const detailWithBody: CommitDetail = {
			...detail,
			body: "This fixes a null pointer issue in the parser.",
		};
		render(CommitDetailComponent, {
			props: {
				commitDetail: detailWithBody,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(
			screen.getByText("This fixes a null pointer issue in the parser."),
		).toBeInTheDocument();
	});

	it("makes the commit summary selectable", () => {
		render(CommitDetailComponent, {
			props: {
				commitDetail: detail,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(screen.getByText("fix: null check")).toHaveClass("select-text");
	});

	it("makes the commit body selectable", () => {
		const detailWithBody: CommitDetail = {
			...detail,
			body: "This fixes a null pointer issue in the parser.",
		};
		render(CommitDetailComponent, {
			props: {
				commitDetail: detailWithBody,
				fileDiffs,
				selectedFile: null,
				onfileselect: vi.fn(),
				onclose: vi.fn(),
			},
		});
		expect(
			screen.getByText("This fixes a null pointer issue in the parser."),
		).toHaveClass("select-text");
	});
});
