import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_CLAMP_LINES } from "../lib/commit-body-clamp.js";
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
		old_path: null,
		status: "Modified",
		is_binary: false,
		hunks: [],
	},
	{
		path: "src/lib/utils.ts",
		old_path: null,
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

	// A long body used to push the file list arbitrarily far down the panel's one
	// scroller, so the files a reader opened the commit for sat below the fold
	// (TRUNK-140).
	describe("long commit bodies", () => {
		const longBody = Array.from(
			{ length: BODY_CLAMP_LINES + 5 },
			(_, i) => `body line ${i}`,
		).join("\n");

		function renderWithBody(body: string | null) {
			return render(CommitDetailComponent, {
				props: {
					commitDetail: { ...detail, body },
					fileDiffs,
					selectedFile: null,
					onfileselect: vi.fn(),
					onclose: vi.fn(),
				},
			});
		}

		it("clamps a body past the limit and offers to show the rest", () => {
			renderWithBody(longBody);
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"true",
			);
			expect(
				screen.getByRole("button", { name: /show more/i }),
			).toBeInTheDocument();
		});

		it("leaves a body within the limit unclamped and offers no control", () => {
			renderWithBody("short enough to read in place");
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"false",
			);
			expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
		});

		it("renders no body block and no control when there is no body", () => {
			renderWithBody(null);
			expect(screen.queryByTestId("commit-body")).toBeNull();
			expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
		});

		it("shows the whole body once expanded, and clamps again on show less", async () => {
			renderWithBody(longBody);

			await fireEvent.click(screen.getByRole("button", { name: /show more/i }));
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"false",
			);

			await fireEvent.click(screen.getByRole("button", { name: /show less/i }));
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"true",
			);
		});

		// An inner scroller here would be an inline scroll area inside the panel's
		// own scroller, which readers skip past. The clamp hides the overflow
		// instead.
		it("never gives the body its own scrollbar", () => {
			renderWithBody(longBody);
			expect(screen.getByTestId("commit-body").style.overflowY).not.toBe(
				"auto",
			);
			expect(screen.getByTestId("commit-body").style.overflowY).not.toBe(
				"scroll",
			);
		});

		it("keeps the files-changed header rendered above the fold while clamped", () => {
			renderWithBody(longBody);
			const body = screen.getByTestId("commit-body");
			const header = screen.getByText("2 files changed");
			// The clamp is what bounds the body's contribution to the panel height;
			// with it applied the header is a sibling below a bounded block rather
			// than below an unbounded one.
			expect(body).toHaveAttribute("data-clamped", "true");
			expect(
				body.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});

		it("re-clamps when a different commit is selected", async () => {
			const { rerender } = renderWithBody(longBody);

			await fireEvent.click(screen.getByRole("button", { name: /show more/i }));
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"false",
			);

			await rerender({
				commitDetail: {
					...detail,
					oid: "othercommitoid",
					short_oid: "otherco",
					body: longBody,
				},
			});
			expect(screen.getByTestId("commit-body")).toHaveAttribute(
				"data-clamped",
				"true",
			);
		});
	});
});
