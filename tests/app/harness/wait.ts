const POLL_MS = 5;
const TIMEOUT_MS = 5_000;

/**
 * Points a timeout back at the card that already investigated it. Two sessions
 * ruled out the deadline, `settle()`, splitting the wait, and reproducing by
 * loading the machine (TRUNK-62); a session meeting this failure fresh would
 * otherwise re-derive all of it. The card is parked, not fixed, so this message
 * is how it comes back.
 */
const KNOWN_FLAKE =
	"This wait has expired before under contention without the application " +
	"being broken. Before investigating, read TRUNK-62 " +
	"(`backlog task 62 --plain`): it records what is already ruled out and how " +
	"to reproduce two of the three known sites on demand.";

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
			throw new Error(`timed out waiting for ${description}\n\n${KNOWN_FLAKE}`);
		}
		await delay(POLL_MS);
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
