import { join } from "node:path";

export type Side = "base" | "head";

export type PassFiles = {
	readonly build: string;
	readonly raw: string;
	readonly normalized: string;
};

export type Outcome =
	| { readonly kind: "compare" }
	| { readonly kind: "fail"; readonly message: string }
	| { readonly kind: "skip"; readonly warning: string };

export function passFiles(directory: string, side: Side): PassFiles {
	return {
		build: join(directory, `${side}-build.jsonl`),
		raw: join(directory, `${side}-output.txt`),
		normalized: join(directory, `${side}-normalized.txt`),
	};
}

export function outcomeOf(passes: {
	readonly base: string;
	readonly basePassed: boolean;
	readonly headPassed: boolean;
}): Outcome {
	if (!passes.headPassed) {
		return { kind: "fail", message: "the pass on the pushed commit failed" };
	}

	if (!passes.basePassed) {
		return {
			kind: "skip",
			warning: `The base pass at ${passes.base} failed, so this run compares nothing.`,
		};
	}

	return { kind: "compare" };
}

const WORKSPACE_SOURCE = "path+";

/**
 * The workspace crates a pass took from an earlier build instead of compiling,
 * read from cargo's --message-format=json output. Both passes share one target
 * directory, and cargo names a workspace crate's artifacts by its path inside the
 * workspace, so a reused crate may hold the other side's code.
 */
export function reusedWorkspaceCrates(messages: string): string[] {
	const reused = new Set<string>();
	for (const line of messages.split("\n")) {
		if (!line.startsWith("{")) {
			continue;
		}

		const message: unknown = JSON.parse(line);
		if (
			typeof message === "object" &&
			message !== null &&
			"reason" in message &&
			message.reason === "compiler-artifact" &&
			"fresh" in message &&
			message.fresh === true &&
			"package_id" in message &&
			typeof message.package_id === "string" &&
			message.package_id.startsWith(WORKSPACE_SOURCE)
		) {
			reused.add(message.package_id);
		}
	}

	return [...reused];
}
