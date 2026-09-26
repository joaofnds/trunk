import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASELINES = join(import.meta.dirname, "baselines");
const DIFFERENCES = join(import.meta.dirname, "differences");

/** Set only by `scripts/visual-accept.sh`, which runs at the user's direction. */
const ACCEPTING = process.env.TRUNK_ACCEPT_VISUAL_BASELINES === "1";

const ACCEPT_HINT =
	"Accept a capture only at the user's explicit direction, with " +
	'`just visual-accept "<reason>"`, which records the reason in docs/visual-baseline-changelog.md. ' +
	"Never set TRUNK_ACCEPT_VISUAL_BASELINES by hand (docs/visual-regression.md).";

export interface Difference {
	pixels: number;
	/** The baseline dimmed, with every differing pixel painted over it. */
	image: Buffer;
}

export type Differ = (baseline: Buffer, capture: Buffer) => Promise<Difference>;

/**
 * Compares `capture` with the committed baseline called `name`, and returns why
 * it does not match, or nothing when it does. A single pixel that `differ`
 * counts is a difference.
 *
 * A mismatch writes the capture and the difference image beside each other in
 * `tests/visual/differences/`, where they are read before anyone accepts them.
 */
export async function mismatch(
	name: string,
	capture: Buffer,
	differ: Differ,
): Promise<string | null> {
	const path = join(BASELINES, `${name}.png`);

	if (!existsSync(path)) {
		if (ACCEPTING) return accept(path, capture);
		record(name, "capture", capture);
		return `${name} has no baseline. Look at ${join(DIFFERENCES, `${name}.capture.png`)}. ${ACCEPT_HINT}`;
	}

	const baseline = readFileSync(path);
	if (baseline.equals(capture)) return null;

	const difference = await differ(baseline, capture);
	// Rewriting a baseline that draws the same pixels would list it as changed.
	if (difference.pixels === 0) return null;
	if (ACCEPTING) return accept(path, capture);

	record(name, "capture", capture);
	record(name, "difference", difference.image);
	return `${name}: ${difference.pixels} pixels differ from the baseline. Look at ${join(DIFFERENCES, `${name}.difference.png`)}. A difference is a suspected defect. ${ACCEPT_HINT}`;
}

function accept(path: string, capture: Buffer): null {
	mkdirSync(BASELINES, { recursive: true });
	writeFileSync(path, capture);
	return null;
}

function record(name: string, kind: string, image: Buffer): void {
	mkdirSync(DIFFERENCES, { recursive: true });
	writeFileSync(join(DIFFERENCES, `${name}.${kind}.png`), image);
}
