import { reportErrorToast } from "./error-report.js";
import { safeInvoke } from "./invoke.js";

/** Runs after the gesture succeeds. The backend emits no `repo-changed` on an
 * `Err` path, so a caller that refreshes locally owns that refresh here. */
type OnDone = () => Promise<void> | void;

export async function mergeBranch({
	repoPath,
	branch,
	openMessageEditor,
	onDone,
}: {
	repoPath: string;
	branch: string;
	openMessageEditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
	onDone?: OnDone;
}): Promise<void> {
	try {
		const result = await safeInvoke<
			| { kind: "ready"; message: string }
			| { kind: "fast_forwarded" }
			| { kind: "conflicts" }
		>("merge_branch_begin", { path: repoPath, branch });

		if (result.kind === "ready") {
			const msg = await openMessageEditor?.(
				result.message,
				"Merge commit message",
			);
			// Returning without continuing leaves the merge in progress on purpose —
			// the user resumes or aborts it from the operation banner.
			if (msg == null) return;
			await safeInvoke("merge_continue", { path: repoPath, message: msg });
		}

		await onDone?.();
	} catch (e) {
		reportErrorToast(e, "Merge failed");
	}
}

export async function rebaseBranch({
	repoPath,
	ontoBranch,
	onDone,
}: {
	repoPath: string;
	ontoBranch: string;
	onDone?: OnDone;
}): Promise<void> {
	try {
		await safeInvoke("rebase_branch", { path: repoPath, ontoBranch });

		await onDone?.();
	} catch (e) {
		reportErrorToast(e, "Rebase failed");
	}
}

export async function resolveForkPoint({
	repoPath,
	branch,
}: {
	repoPath: string;
	branch: string;
}): Promise<string | null> {
	try {
		return await safeInvoke<string>("get_fork_point", {
			path: repoPath,
			branch,
		});
	} catch (e) {
		reportErrorToast(e, "Failed to detect fork point");
		return null;
	}
}
