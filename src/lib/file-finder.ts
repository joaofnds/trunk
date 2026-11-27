import { createPathFilter } from "./path-filter.js";
import type { TrackedFile } from "./types.js";

/** The review picker groups changed files first, then ranks each group by query. */
export function createFileFinder(files: TrackedFile[]) {
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
	const changed = createPathFilter(sorted.filter((file) => file.changed));
	const unchanged = createPathFilter(sorted.filter((file) => !file.changed));

	return (query: string) => [...changed(query), ...unchanged(query)];
}
