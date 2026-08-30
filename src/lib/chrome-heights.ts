/** The unit the chrome scale is built from. It mirrors `--u` in app.css, and
 *  src/app.css.test.ts fails if the two disagree.
 *
 *  Virtualized surfaces compute their offsets before layout, so they cannot read
 *  the custom property and take their multiple from here instead.
 *
 *  Not every length in the app is on this scale: the graph's dot radius and
 *  stroke widths are drawing values, and Tailwind's utility classes carry their
 *  own spacing and radius theme. What the guard covers is app.css's declared
 *  lengths and the constants here that mirror them. */
export const UNIT = 4;

/** An in-pane bar: a pane heading, a toolbar, a section header. Mirrors
 *  `--bar-h`. */
export const BAR_HEIGHT = 7 * UNIT;

/** A list row: a file, a directory, a branch, a commit. Mirrors `--row-h`. */
export const ROW_HEIGHT = 7 * UNIT;

/** A staging-tree row's left inset: one step of gutter, plus four per level of
 *  nesting. Stated here rather than in each row component, which restated the
 *  same two numbers, and derived from the unit so a rescale reaches it. */
export function treeIndent(depth: number): string {
	return `${2 * UNIT + depth * 4 * UNIT}px`;
}
