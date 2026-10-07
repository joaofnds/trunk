// The person at the keyboard, as the review draws them beside their comments.
// The repo view provides it from the repository's `user.name`, so a card or a
// reply anywhere under it shows the same face without being handed it.

import { getContext, setContext } from "svelte";

export interface Reviewer {
	/** The first letters of the first and last words of the name, or null
	 *  while the name is unknown or unset. */
	readonly initials: string | null;
}

/** The context key, exported for a test that renders under a known reviewer. */
export const REVIEWER = Symbol("reviewer");

export function provideReviewer(reviewer: Reviewer): void {
	setContext(REVIEWER, reviewer);
}

export function reviewer(): Reviewer | undefined {
	return getContext<Reviewer | undefined>(REVIEWER);
}

export function initials(name: string): string | null {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	const first = [...words[0]][0];
	const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
	return (first + last).toUpperCase();
}
