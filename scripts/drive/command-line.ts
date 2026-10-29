/**
 * How the drive CLI (scripts/drive/drive.ts) reads its command line: a verb,
 * the words it takes, and for a verb that finds a control by role and name, a
 * trailing `--in <landmark role>`.
 */

/** A command line the verbs cannot read, reported apart from a failure inside
 *  the instance. */
export class UsageError extends Error {}

/** The verbs that find their control by role and name, and so can be told
 *  which landmark to look within. */
const SCOPED_VERBS = new Set(["click", "context", "type"]);

export interface CommandLine {
	readonly verb: string | undefined;
	readonly words: readonly string[];
	/** The landmark role `--in` named, or null without one. */
	readonly within: string | null;
}

export function parse(args: readonly string[]): CommandLine {
	const [verb, ...words] = args;
	const inAt = verb && SCOPED_VERBS.has(verb) ? words.indexOf("--in") : -1;
	if (inAt === -1) return { verb, words, within: null };

	const within = words[inAt + 1];
	if (within === undefined || words.length > inAt + 2) {
		throw new UsageError(
			"--in takes one landmark role and ends the command line",
		);
	}
	return { verb, words: words.slice(0, inAt), within };
}

/**
 * The arguments a page hook gets: exactly the `count` words the verb takes, so
 * a name or text left unquoted is refused rather than cut at its first space,
 * then the landmark to look within.
 */
export function hookArguments(line: CommandLine, count: number): string[] {
	if (line.words.length !== count) {
		throw new UsageError(
			`${line.verb} takes ${count} arguments and got ${line.words.length}; quote a name or text that holds spaces`,
		);
	}

	return line.within === null ? [...line.words] : [...line.words, line.within];
}
