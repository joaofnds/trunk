import {
	type FoundMatches,
	findLiteralMatches,
	type MatchRange,
} from "./literal-pattern.js";

interface MessageLocation {
	readonly part: "summary" | "body";
}

export type MessageMatch = MessageLocation & MatchRange;

export function messageMatches(
	summary: string,
	body: string | null,
	query: string,
): FoundMatches<MessageMatch> {
	return findLiteralMatches<MessageLocation>(query, (collect) => {
		collect(summary, { part: "summary" });
		if (body) collect(body, { part: "body" });
	});
}
