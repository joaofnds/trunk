import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mismatch } from "./baseline.js";
import { CatalogHarness } from "./harness.js";

describe("design catalog", () => {
	let harness: CatalogHarness;

	beforeAll(async () => {
		harness = await CatalogHarness.setup();
	});

	afterAll(async () => {
		await harness?.teardown();
	});

	test("draws every token and primitive as its baseline shows", async (context) => {
		const capture = await harness.capture(context);

		const reason = await mismatch("catalog", capture, (baseline, actual) =>
			harness.difference(baseline, actual),
		);
		expect(reason).toBeNull();
	});
});
