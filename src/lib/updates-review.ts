import type {
	ReviewComposerTarget,
	ReviewEditorStore,
	ReviewUpdateComposer,
} from "./review-editors.svelte.js";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readReviewUpdateSnapshot(
	value: unknown,
): ReviewUpdateComposer | null {
	if (value === null || value === undefined) return null;
	if (
		!record(value) ||
		!record(value.target) ||
		!record(value.captured) ||
		!record(value.captured.anchor)
	)
		throw new Error(
			"The saved comment snapshot is invalid; it has been retained for recovery.",
		);
	const target = value.target;
	const capture = value.captured;
	const anchor = value.captured.anchor;
	if (
		typeof value.text !== "string" ||
		!(value.reviewId === null || typeof value.reviewId === "string") ||
		!(value.mode === "diff" || value.mode === "full-file") ||
		target.context !== "normal" ||
		typeof target.filePath !== "string" ||
		target.compareBaseOid !== null ||
		typeof capture.cachedExcerpt !== "string" ||
		!(
			capture.wholeFile === undefined || typeof capture.wholeFile === "boolean"
		) ||
		typeof anchor.commit_oid !== "string" ||
		anchor.file_path !== target.filePath ||
		!(anchor.source === "Diff" || anchor.source === "FullFile") ||
		!(anchor.side === "Old" || anchor.side === "New") ||
		typeof anchor.start_line !== "number" ||
		!Number.isSafeInteger(anchor.start_line) ||
		anchor.start_line < 1 ||
		typeof anchor.end_line !== "number" ||
		!Number.isSafeInteger(anchor.end_line) ||
		anchor.end_line < anchor.start_line
	)
		throw new Error(
			"The saved comment snapshot is invalid; it has been retained for recovery.",
		);
	let destination: ReviewComposerTarget;
	if (target.kind === "commit" && typeof target.commitOid === "string")
		destination = {
			context: "normal",
			kind: "commit",
			commitOid: target.commitOid,
			compareBaseOid: null,
			filePath: target.filePath,
		};
	else if (
		(target.kind === "staged" ||
			target.kind === "unstaged" ||
			target.kind === "current_file") &&
		target.commitOid === null
	)
		destination = {
			context: "normal",
			kind: target.kind,
			commitOid: null,
			compareBaseOid: null,
			filePath: target.filePath,
		};
	else
		throw new Error(
			"The saved comment target cannot be restored; it has been retained for recovery.",
		);

	return {
		target: destination,
		mode: value.mode,
		text: value.text,
		reviewId: value.reviewId,
		captured: {
			cachedExcerpt: capture.cachedExcerpt,
			wholeFile: capture.wholeFile,
			anchor: {
				commit_oid: anchor.commit_oid,
				file_path: target.filePath,
				source: anchor.source,
				side: anchor.side,
				start_line: anchor.start_line,
				end_line: anchor.end_line,
			},
		},
	};
}

export async function restoreReviewUpdateComposer(
	editors: ReviewEditorStore,
	saved: ReviewUpdateComposer,
): Promise<void> {
	if (!saved.target.filePath)
		throw new Error("The saved comment file is missing.");
	const session = editors.composer(saved.target, saved.reviewId);
	const opened =
		saved.mode === "full-file"
			? session.openFullFile(
					saved.target.filePath,
					saved.captured,
					saved.reviewId,
					saved.target,
				)
			: session.openDiff(saved.captured, saved.reviewId, saved.target);
	if (!opened)
		throw new Error(
			"Finish the open comment before restoring the saved draft.",
		);
	session.draft.text = saved.text;
	await session.restoreDraft(async () => null);
}
