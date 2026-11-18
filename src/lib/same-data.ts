/**
 * Whether two values decoded from the same JSON shape hold the same data:
 * equal primitives, arrays of equal items in order, and objects with the same
 * keys holding equal values. A key holding `undefined` counts as absent, the
 * way JSON drops it.
 */
export function sameData(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) if (!sameData(left[key], right[key])) return false;
	return true;
}
