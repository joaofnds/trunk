/**
 * Pure capture-time adapter: translates an in-memory diff line selection into
 * a stable source-coordinate `Anchor` plus a diff-format `cachedExcerpt`.
 *
 * All functions are pure (no side effects, no IPC, no mutation of inputs) and
 * fully tested. The diff comment composer (Plan 02) imports `buildDiffAnchor`
 * to turn a user's line selection into the payload for the `add_comment`
 * command, which stays a dumb writer.
 *
 * Two outputs diverge on purpose (RESEARCH Pitfall 3):
 * - `anchor.start_line..end_line` is min..max over the chosen side's line
 *   numbers, so dropped Delete lines never widen a New-side range (L-03).
 * - `cachedExcerpt` is built over the contiguous min..max INDEX span of the
 *   selection, so dropped `-` lines and in-between context still appear (L-06).
 */

import type {
	Anchor,
	DiffHunk,
	DiffLine,
	DiffStatus,
	FileDiff,
	Side,
} from "./types.js";

export interface DiffAnchorResult {
	anchor: Anchor;
	cachedExcerpt: string;
}

/**
 * Resolve the anchor side. File status wins over the selected origins:
 * Added -> New, Deleted -> Old, Renamed/Copied -> New (the new path).
 * For Modified/Untracked/Unknown, derive from origins: any Add -> New,
 * else any Delete -> Old, else a defensive New default.
 */
export function resolveSide(status: DiffStatus, selected: DiffLine[]): Side {
	if (status === "Added") return "New";
	if (status === "Deleted") return "Old";
	if (status === "Renamed") return "New";
	if (status === "Copied") return "New";

	const hasAdd = selected.some((l) => l.origin === "Add");
	if (hasAdd) return "New";
	const hasDelete = selected.some((l) => l.origin === "Delete");
	if (hasDelete) return "Old";
	return "New";
}

/**
 * A line's content without the newline libgit2 leaves on it, since an excerpt
 * joins its lines with one.
 */
export function lineText(line: DiffLine): string {
	return line.content.endsWith("\n") ? line.content.slice(0, -1) : line.content;
}

/**
 * Prefix a diff line by origin in standard diff format: `+`/`-`/space followed
 * by the original content (its own leading whitespace preserved).
 */
function prefixLine(line: DiffLine): string {
	const content = lineText(line);
	if (line.origin === "Add") return `+${content}`;
	if (line.origin === "Delete") return `-${content}`;
	return ` ${content}`;
}

/**
 * The set of line indices a user could select within a hunk: every non-context
 * line (origin !== 'Context'). This is the same `isSelectable` convention the
 * diff views use for click targets. Used to synthesize a full-hunk selection
 * when commenting on a whole hunk without first picking individual lines —
 * including Delete lines, so a pure-deletion hunk still resolves to the Old
 * side and trips the existing New-side scope guard.
 */
export function hunkSelectableIndices(hunk: DiffHunk): Set<number> {
	const indices = new Set<number>();
	hunk.lines.forEach((line, i) => {
		if (line.origin !== "Context") indices.add(i);
	});
	return indices;
}

/**
 * Build the source-coordinate anchor and diff-format excerpt for a selection
 * of line indices within `file.hunks[hunkIdx]`.
 */
export function buildDiffAnchor(
	commitOid: string,
	file: FileDiff,
	hunkIdx: number,
	selectedLineIndices: Set<number>,
): DiffAnchorResult {
	const hunkLines = file.hunks[hunkIdx].lines;
	const selectedIndices = Array.from(selectedLineIndices).sort((a, b) => a - b);
	const selected = selectedIndices.map((i) => hunkLines[i]);

	const side = resolveSide(file.status, selected);

	const lineNumbers = selected
		.map((l) => (side === "New" ? l.new_lineno : l.old_lineno))
		.filter((n): n is number => n !== null);
	const start_line = Math.min(...lineNumbers);
	const end_line = Math.max(...lineNumbers);

	const spanStart = selectedIndices[0];
	const spanEnd = selectedIndices[selectedIndices.length - 1];
	const cachedExcerpt = hunkLines
		.slice(spanStart, spanEnd + 1)
		.map(prefixLine)
		.join("\n");

	const anchor: Anchor = {
		commit_oid: commitOid,
		file_path: file.path,
		source: "Diff",
		side,
		start_line,
		end_line,
	};

	return { anchor, cachedExcerpt };
}
