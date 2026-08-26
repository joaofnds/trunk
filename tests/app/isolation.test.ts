import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** Everything a second runner would have to load to drive the application. */
const HARNESS_ROOTS = [
	"tests/app/harness",
	"tests/app/drivers",
	"tests/app/fakes",
];

/** The harness roots plus the tests themselves. */
const SUITE_ROOTS = ["tests/app"];

const VITEST_IMPORT = /\bfrom\s+["']vitest["']|require\(["']vitest["']\)/;
const IPC_MOCK = /tauri-mock|\bvi\.mock\b/;
const MENU_API =
	/\bfrom\s+["']@tauri-apps\/api\/menu["']|import\(["']@tauri-apps\/api\/menu["']\)/;

const ONE_COMMIT: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "one" },
		{ step: "commit", message: "First" },
	],
};

describe("each test", () => {
	let previous: { repo: string; home: string };

	afterEach(teardown);

	it("commits into a repository of its own", async () => {
		const app = await setup({ repo: ONE_COMMIT });
		previous = { repo: app.repo.path, home: app.home };
		await app.repo.open();
		writeFileSync(join(app.repo.path, "b.txt"), "b");
		await app.events.externalChange(app.repo.path);
		await app.staging.open();
		await app.staging.stageEverything();

		await app.staging.commit("From the first test");

		await expect(
			waitFor("the new commit", () => {
				const rows = app.repo.commitRows();
				return rows.includes("From the first test") ? rows : null;
			}),
		).resolves.toEqual(["From the first test", "First"]);
	});

	it("sees nothing of the test that ran before it", async () => {
		const app = await setup({ repo: ONE_COMMIT });

		await app.repo.open();

		expect(app.repo.commitRows()).toEqual(["First"]);
		expect(app.repo.path).not.toBe(previous.repo);
		expect(existsSync(previous.home)).toBe(false);
	});
});

describe("the harness", () => {
	it("imports nothing from vitest", () => {
		expect(sourcesMatching(VITEST_IMPORT)).toEqual([]);
	});

	it("reaches for no IPC mock", () => {
		expect(sourcesMatching(IPC_MOCK)).toEqual([]);
	});

	it("drives the native menu without importing its API", () => {
		expect(sourcesMatching(MENU_API, SUITE_ROOTS)).toEqual([]);
	});
});

function sourcesMatching(
	pattern: RegExp,
	roots: string[] = HARNESS_ROOTS,
): string[] {
	return roots
		.flatMap(sourcesUnder)
		.filter((path) => pattern.test(readFileSync(path, "utf8")));
}

function sourcesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}
