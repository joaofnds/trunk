/**
 * What a virtualized diff view publishes so the host can jump around it.
 *
 * A virtualized view has no stable element per hunk — the row a jump targets is
 * usually not mounted when the jump happens — so navigation goes through row
 * indices the view owns rather than through `scrollIntoView` on a bound node.
 * RenderedDiff still renders every row and publishes nothing, so the host falls
 * back to its element record for that one.
 */
export interface DiffNav {
	/** How many hunks `[` and `]` step through. */
	hunkCount(): number;
	/** A hunk's place in that sequence, or -1 when it is not rendered. */
	ordinalOf(path: string, hunkIdx: number): number;
	/** Scrolls the hunk into view and flashes it. */
	scrollToHunk(ordinal: number): void;
	/** Scrolls one line's own row into view, falling back to its hunk. */
	scrollToLine(path: string, hunkIdx: number, lineIdx: number): void;
}
