/** The keys that move the graph's selection, as `keyChord` names them. */
export type GraphKey =
	| "ArrowDown"
	| "ArrowUp"
	| "PageDown"
	| "PageUp"
	| "Home"
	| "End";

const GRAPH_KEYS: ReadonlySet<string> = new Set<GraphKey>([
	"ArrowDown",
	"ArrowUp",
	"PageDown",
	"PageUp",
	"Home",
	"End",
]);

export function isGraphKey(chord: string): chord is GraphKey {
	return GRAPH_KEYS.has(chord);
}

/**
 * The row `key` moves the selection to, from row `current` (-1 when no loaded row
 * is selected) in a list of `count` rows of which `pageRows` fit in view. Null when
 * the selection stays where it is.
 */
export function graphKeyTarget(
	key: GraphKey,
	current: number,
	count: number,
	pageRows: number,
): number | null {
	if (count === 0) return null;
	const last = count - 1;
	const target = (() => {
		switch (key) {
			case "ArrowDown":
				return current === -1 ? 0 : Math.min(current + 1, last);
			case "ArrowUp":
				return Math.max(current - 1, 0);
			case "PageDown":
				return Math.min(Math.max(current, 0) + pageRows, last);
			case "PageUp":
				return Math.max(current - pageRows, 0);
			case "Home":
				return 0;
			case "End":
				return last;
		}
	})();
	const upward = key === "ArrowUp" || key === "PageUp";
	return target === current || (current === -1 && upward) ? null : target;
}
