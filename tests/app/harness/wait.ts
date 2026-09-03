const POLL_MS = 5;
const TIMEOUT_MS = 5_000;

/**
 * Points a timeout back at the card that already investigated it. Two sessions
 * ruled out the deadline, the harness's old quiet window, splitting the wait,
 * and reproducing by loading the machine (TRUNK-62); a session meeting this
 * failure fresh would otherwise re-derive all of it. The card is parked, not
 * fixed, so this message is how it comes back.
 */
const KNOWN_FLAKE =
	"This wait has expired before under contention without the application " +
	"being broken. Before investigating, read TRUNK-62 " +
	"(`backlog task 62 --plain`): it records what is already ruled out and how " +
	"to reproduce two of the three known sites on demand. The outstanding " +
	"commands above are the evidence that card was waiting for: a command with " +
	"a large age means the host never answered, and none outstanding means it " +
	"answered and the frontend did not act on it. Attach them to the card.";

/**
 * What the running application was still owed when a wait expired. The harness
 * installs one when it spawns a host and clears it on teardown, so the 265
 * `waitFor` call sites keep their two arguments and still get the evidence.
 */
type TimeoutDescriber = () => string;

let describeHost: TimeoutDescriber | null = null;

/** Registers the source the next timeout reports from, or clears it. */
export function describeTimeout(source: TimeoutDescriber | null): void {
	describeHost = source;
}

/** Never lets a failing diagnostic replace the failure being diagnosed. */
function diagnostics(): string {
	if (!describeHost) return "";
	try {
		return `\n\n${describeHost()}`;
	} catch (error) {
		return `\n\n(diagnostics failed: ${String(error)})`;
	}
}

/**
 * Resolves as soon as `condition` produces a value. Waiting on state rather
 * than on the clock is what keeps an event-following assertion off a fixed
 * sleep, and it returns the moment the state arrives instead of paying out a
 * whole quiet window.
 */
export async function waitFor<T>(
	description: string,
	condition: () => T | null,
	timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const value = condition();
		if (value !== null) return value;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for ${description}${diagnostics()}\n\n${KNOWN_FLAKE}`,
			);
		}
		await delay(POLL_MS);
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
