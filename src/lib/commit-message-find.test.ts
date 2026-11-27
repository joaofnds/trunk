import { describe, expect, it } from "vitest";
import { messageMatches } from "./commit-message-find.js";

describe(messageMatches, () => {
	it("seeks backward through dense literal matches from the body to the summary", () => {
		const summary = "İ[K]";
		const body = `${"🙂[K] ".repeat(512)}[k]`;

		const matches = messageMatches(summary, body, "[k]");

		expect(matches.length).toBe(514);
		expect(matches.at(513)).toEqual({ part: "body", start: 3072, end: 3075 });
		expect(matches.at(257)).toEqual({ part: "body", start: 1538, end: 1541 });
		expect(matches.at(1)).toEqual({ part: "body", start: 2, end: 5 });
		expect(matches.at(0)).toEqual({ part: "summary", start: 1, end: 4 });
	});
});
