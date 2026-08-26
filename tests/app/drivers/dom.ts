/** The first element matching `selector` whose text satisfies `matches`, or null
 *  while the interface is not showing one. Every driver locates its target by
 *  what the user reads on it. */
export function firstMatching(
	selector: string,
	matches: (text: string) => boolean,
): HTMLElement | null {
	const candidates = document.querySelectorAll<HTMLElement>(selector);
	for (const candidate of candidates) {
		if (matches(candidate.textContent?.trim() ?? "")) return candidate;
	}
	return null;
}
