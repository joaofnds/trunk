// Svelte's transitions run through the Web Animations API, outside CSS media rules.
export function motionDuration(milliseconds: number): number {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
		? 0
		: milliseconds;
}
