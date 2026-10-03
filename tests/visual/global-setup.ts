import { clearDifferences } from "./baseline.js";

/** Once per run, before any file: two files clearing at their own start would
 *  each delete what the other had already written. */
export function setup(): void {
	clearDifferences();
}
