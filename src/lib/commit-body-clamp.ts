/** How many rendered lines of a commit body the detail panel shows before it
 *  clamps. A fixed count rather than a fraction of the panel height, so the
 *  panel looks the same at every window size and the decision is testable
 *  without a layout engine (TRUNK-140). */
export const BODY_CLAMP_LINES = 10;

/** Rough width, in characters, at which a body line wraps in the detail panel.
 *  The clamp only decides whether to offer a control, so an approximation that
 *  errs toward offering it costs a reader nothing; a body that turns out to fit
 *  shows a control that expands to the same height it already had. Measuring
 *  the real wrap point would tie this decision to a mounted element and to a
 *  panel the user can resize. */
const WRAP_COLUMNS = 80;

/** Whether the body is long enough that clamping it hides something.
 *
 *  `white-space: pre-wrap` renders both explicit newlines and wrapped overflow
 *  as lines, so a body with one very long paragraph overflows just as a body
 *  with many short lines does. Counting newlines alone would miss it. */
export function bodyOverflows(body: string | null): boolean {
	if (!body) return false;

	let lines = 0;
	for (const line of body.split("\n")) {
		lines += Math.max(1, Math.ceil(line.length / WRAP_COLUMNS));
		if (lines > BODY_CLAMP_LINES) return true;
	}
	return false;
}
