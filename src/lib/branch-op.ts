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
		const result = await safeInvoke<{ kind: string; message?: string }>(
			"merge_branch_begin",
			{ path: repoPath, branch },
		);

		if (result.kind === "ready") {
			const msg = await openMessageEditor?.(
				result.message ?? "",
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

export async function interactiveRebaseFrom({
	repoPath,
	branch,
	onForkPoint,
}: {
	repoPath: string;
	branch: string;
	onForkPoint: (forkPoint: string) => void;
}): Promise<void> {
	try {
		const forkPoint = await safeInvoke<string>("get_fork_point", {
			path: repoPath,
			branch,
		});

		onForkPoint(forkPoint);
	} catch (e) {
		reportErrorToast(e, "Failed to detect fork point");
	}
}
