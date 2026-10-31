import { join } from "node:path";

export type Side = "base" | "head";

export type PassFiles = {
	readonly raw: string;
	readonly normalized: string;
};

export type Outcome =
	| { readonly kind: "compare" }
	| { readonly kind: "fail"; readonly message: string }
	| { readonly kind: "skip"; readonly warning: string };

export function passFiles(directory: string, side: Side): PassFiles {
	return {
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
