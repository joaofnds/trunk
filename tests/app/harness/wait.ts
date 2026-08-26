const POLL_MS = 5;
const TIMEOUT_MS = 5_000;

/**
 * Resolves as soon as `condition` produces a value. Waiting on state rather
 * than on the clock is what keeps an event-following assertion off a fixed
 * sleep, and it returns the moment the state arrives instead of paying out a
 * whole quiet window.
 */
export async function waitFor<T>(
	description: string,
	condition: () => T | null,
): Promise<T> {
	const deadline = Date.now() + TIMEOUT_MS;

	while (true) {
		const value = condition();
		if (value !== null) return value;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${description}`);
		}
		await delay(POLL_MS);
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
