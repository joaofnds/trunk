import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchReport } from "../lib/autofetch-status.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SHOW_DELAY_MS } from "../lib/tooltip.js";
import PullDropdown from "./PullDropdown.svelte";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const checkedAt = 1_000_000;
const retryAt = 2_000_000;
const checkedTime = new Date(checkedAt).toLocaleTimeString();
const retryTime = new Date(retryAt).toLocaleTimeString();

function report(
	outcome: FetchReport["outcome"],
	error: string | null = null,
): FetchReport {
	return {
		outcome,
		graph_error: null,
		graph_rebuilds: 0,
		remotes: [
			{
				remote: "origin",
				outcome,
				last_attempt_ms: checkedAt,
				last_success_ms: checkedAt,
				retry_at_ms: error ? retryAt : null,
				error_code: error ? "authentication_failed" : null,
				error_message: error,
				metadata_error_code: null,
				metadata_error_message: null,
			},
		],
	};
}

describe("Pull automatic fetch status", () => {
	it.each([
		{
			report: report("unchanged"),
			expected: `origin: last checked ${checkedTime}`,
		},
		{
			report: report("failed", "automatic fetch failed"),
			expected: `origin: automatic fetch failed; last checked ${checkedTime}; retry after ${retryTime}`,
		},
		{
			report: report("unsupported", "automatic fetch unavailable"),
			expected: `origin: automatic fetch unavailable; use Fetch; last checked ${checkedTime}; retry after ${retryTime}`,
		},
		{
			report: { ...report("unchanged"), graph_error: "graph_changed" },
			expected: "The graph could not refresh; try refreshing the repository.",
		},
		{
			report: {
				...report("unchanged"),
				remotes: [],
				graph_error: "graph_changed",
			},
			expected: "The graph could not refresh; try refreshing the repository.",
		},
		{
			report: {
				...report("failed"),
				remotes: [],
				job_error: "Automatic fetch could not start; try Fetch.",
			},
			expected: "Automatic fetch could not start; try Fetch.",
		},
		{
			report: {
				...report("cancelled"),
				remotes: [
					{
						...report("cancelled").remotes[0],
						metadata_error_code: "fetch_head_error",
						metadata_error_message: "Fetch metadata could not be restored.",
					},
				],
			},
			expected: "automatic fetch cancelled; last checked",
		},
	])(
		"associates the on-demand status $expected with Pull",
		({ report, expected }) => {
			const state = createRemoteState();
			state.autofetch = report;
			render(PullDropdown, {
				props: {
					repoPath: "/repo",
					disabled: false,
					remoteState: state,
					onpull() {},
				},
			});

			expect(
				screen.getByRole("button", { name: "Pull" }),
			).toHaveAccessibleDescription(expect.stringContaining(expected));
		},
	);

	it("keeps cancellation and metadata cleanup failure visible together", () => {
		const state = createRemoteState();
		state.autofetch = {
			...report("cancelled"),
			remotes: [
				{
					...report("cancelled").remotes[0],
					metadata_error_code: "fetch_head_error",
					metadata_error_message: "Fetch metadata could not be restored.",
				},
			],
		};
		render(PullDropdown, {
			props: {
				repoPath: "/repo",
				disabled: false,
				remoteState: state,
				onpull() {},
			},
		});

		expect(
			screen.getByRole("button", { name: "Pull" }),
		).toHaveAccessibleDescription(
			expect.stringContaining(
				`automatic fetch cancelled; last checked ${checkedTime}; Fetch metadata could not be restored.`,
			),
		);
	});

	it("updates an open tooltip and accessible status after a failed check", async () => {
		vi.useFakeTimers();
		const state = createRemoteState();
		state.autofetch = report("unchanged");
		render(PullDropdown, {
			props: {
				repoPath: "/repo",
				disabled: false,
				remoteState: state,
				onpull() {},
			},
		});
		const pull = screen.getByRole("button", { name: "Pull" });
		await fireEvent.focus(pull);
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		await tick();
		const tooltip = document.querySelector(".tooltip-pop");

		state.autofetch = report("failed", "automatic fetch failed");
		await tick();

		expect(tooltip).toHaveTextContent(
			`origin: automatic fetch failed; last checked ${checkedTime}; retry after ${retryTime}`,
		);
		expect(pull).toHaveAccessibleDescription(
			expect.stringContaining("automatic fetch failed"),
		);
	});
});
