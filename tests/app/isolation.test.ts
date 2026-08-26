import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Everything a second runner would have to load to drive the application. */
const HARNESS_ROOTS = [
	"tests/app/harness",
	"tests/app/drivers",
	"tests/app/fakes",
];

const VITEST_IMPORT = /\bfrom\s+["']vitest["']|require\(["']vitest["']\)/;
const IPC_MOCK = /tauri-mock|\bvi\.mock\b/;

describe("the harness", () => {
	it("imports nothing from vitest", () => {
		expect(sourcesMatching(VITEST_IMPORT)).toEqual([]);
	});

	it("reaches for no IPC mock", () => {
		expect(sourcesMatching(IPC_MOCK)).toEqual([]);
	});
});

function sourcesMatching(pattern: RegExp): string[] {
	return HARNESS_ROOTS.flatMap(sourcesUnder).filter((path) =>
		pattern.test(readFileSync(path, "utf8")),
	);
}

function sourcesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}
