import { describe, expect, it } from "vitest";
import { hookArguments, parse, UsageError } from "./command-line.js";

describe("parse", () => {
	it("reads the landmark a scoped verb is told to look within", () => {
		expect(
			parse(["click", "button", "feature", "--in", "complementary"]),
		).toEqual({
			verb: "click",
			words: ["button", "feature"],
			within: "complementary",
		});
	});

	it("leaves --in as a word for a verb that finds no control", () => {
		expect(parse(["choose", "--in"])).toEqual({
			verb: "choose",
			words: ["--in"],
			within: null,
		});
	});

	it.each([
		["with no role after it", ["click", "button", "feature", "--in"]],
		[
			"before other words",
			["type", "textbox", "--in", "main", "Summary", "fix"],
		],
	])("refuses --in %s", (_how, args) => {
		expect(() => parse(args)).toThrow(
			new UsageError("--in takes one landmark role and ends the command line"),
		);
	});
});

describe("hookArguments", () => {
	it("hands the hook its words, then the landmark", () => {
		const line = parse([
			"context",
			"button",
			"feature",
			"--in",
			"complementary",
		]);

		expect(hookArguments(line, 2)).toEqual([
			"button",
			"feature",
			"complementary",
		]);
	});

	it("hands an unscoped hook its words alone", () => {
		expect(hookArguments(parse(["click", "button", "Commit"]), 2)).toEqual([
			"button",
			"Commit",
		]);
	});

	it("refuses a name left unquoted, rather than cutting it at a space", () => {
		const line = parse(["click", "button", "Open", "Repository"]);

		expect(() => hookArguments(line, 2)).toThrow(
			new UsageError(
				"click takes 2 arguments and got 3; quote a name or text that holds spaces",
			),
		);
	});
});
