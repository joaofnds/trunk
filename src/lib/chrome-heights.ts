/** The unit every length in the interface is an integer multiple of. It mirrors
 *  `--u` in app.css; src/app.css.test.ts fails if the two disagree.
 *
 *  Virtualized surfaces compute their offsets before layout, so they cannot read
 *  the custom property and take their multiple from here instead. */
export const UNIT = 4;

export const BAR_HEIGHT = 7 * UNIT;
