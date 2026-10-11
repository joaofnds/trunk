export type FetchOutcome =
	| "changed"
	| "unchanged"
	| "skipped_fresh"
	| "skipped_busy"
	| "skipped_operation"
	| "skipped_backoff"
	| "failed"
	| "unsupported"
	| "cancelled"
	| "timed_out";

export interface FetchReport {
	outcome: FetchOutcome;
	remotes: Array<{
		remote: string;
		outcome: FetchOutcome;
		last_attempt_ms: number | null;
		last_success_ms: number | null;
		retry_at_ms: number | null;
		error_code: string | null;
		error_message: string | null;
		readonly metadata_error_code: string | null;
		readonly metadata_error_message: string | null;
	}>;
	graph_error: string | null;
	graph_rebuilds: number;
	job_error?: string;
}

/** Freshness stays available on demand, without a recurring notification. */
export function autofetchSummary(report?: FetchReport): string {
	if (!report) return "Pull";
	if (report.remotes.length === 0 && !report.job_error && !report.graph_error)
		return "Pull";
	const lines = report.remotes.map((remote) => {
		const checked =
			remote.last_success_ms === null
				? "not checked yet"
				: `last checked ${new Date(remote.last_success_ms).toLocaleTimeString()}`;
		let state = "";
		if (remote.outcome === "unsupported")
			state = `${remote.error_message ?? "automatic fetch unavailable for this configuration"}; use Fetch`;
		else if (remote.outcome === "timed_out")
			state = "automatic fetch timed out";
		else if (remote.outcome === "cancelled")
			state = "automatic fetch cancelled";
		else if (remote.error_code || remote.outcome === "failed")
			state = remote.error_message ?? "automatic fetch failed";
		const retry =
			remote.retry_at_ms === null
				? ""
				: `; retry after ${new Date(remote.retry_at_ms).toLocaleTimeString()}`;
		const metadata = remote.metadata_error_code
			? `; ${remote.metadata_error_message ?? "fetch metadata could not be restored"}`
			: "";
		return `${remote.remote}: ${state ? `${state}; ` : ""}${checked}${retry}${metadata}`;
	});
	if (report.graph_error)
		lines.push("The graph could not refresh; try refreshing the repository.");
	if (report.job_error) lines.push(report.job_error);
	return `Pull\nAutomatic fetch\n${lines.join("\n")}`;
}
