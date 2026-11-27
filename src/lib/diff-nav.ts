import type { DiffRow, ReadingLine } from "./diff-rows.js";
import type { ThreadReadingPosition } from "./diff-thread-position.js";
import type { Side } from "./types.js";

/**
 * What a virtualized diff view publishes so the host can jump around it.
 *
 * A virtualized view has no stable element per hunk — the row a jump targets is
 * usually not mounted when the jump happens — so navigation goes through row
 * indices the view owns rather than through `scrollIntoView` on a bound node.
 */
export interface DiffNav {
	searchRows(): readonly DiffRow[];
	revealSearchRow(row: number): void;
	/** Whether the rows can receive a jump. */
	isReady(): boolean;
	/** A hunk's place in that sequence, or -1 when it is not rendered. */
	ordinalOf(path: string, hunkIdx: number): number;
	/** Scrolls the hunk into view, flashing its header where the view draws
	 *  one. */
	scrollToHunk(ordinal: number): void;
	/** Scrolls one line's own row into view, falling back to its hunk. */
	scrollToLine(path: string, hunkIdx: number, lineIdx: number): void;
	/** Scrolls to the comment row drawing a thread that starts on `startLine`,
	 *  reporting false when no row draws one. */
	scrollToThread(path: string, side: Side, startLine: number): boolean;
	/** Scrolls to the next (1) or previous (-1) step from where the reader is,
	 *  and flashes it: a hunk while the view shows hunks, a run of changed lines
	 *  while it shows the file whole. Stays put when there is none that way. */
	step(direction: 1 | -1): void;
	/** The line at the top of the view, where a view replacing it opens. */
	readingLine(): ReadingLine | null;
	readingThread(): ThreadReadingPosition | null;
}

/** Where the last jump left the view: the stop it went to, and the row that
 *  put at the top. */
export interface StopJump {
	readonly ordinal: number;
	readonly top: number;
}

/**
 * The stop `]` (1) or `[` (-1) goes to, among rows in ascending order, or -1
 * when there is none that way.
 *
 * It steps on from the last jump while the top is still the row that jump left
 * there, since near the end the list cannot scroll a stop up to the top and the
 * top alone would pick the same stop again. Once the reader has scrolled, it
 * steps from the row at the top, so the next stop is the next one below what
 * is on screen and never one back where an old jump left off.
 */
export function adjacentStop(
	stops: readonly number[],
	top: number,
	direction: 1 | -1,
	last: StopJump | null,
): number {
	if (last !== null && last.top === top) {
		const next = last.ordinal + direction;
		return next >= 0 && next < stops.length ? next : -1;
	}

	return direction === 1
		? stops.findIndex((row) => row > top)
		: stops.findLastIndex((row) => row < top);
}
