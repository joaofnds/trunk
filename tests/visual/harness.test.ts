import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SuiteHarness } from "./harness.js";

/** A fixture build stalled on a loaded machine: it never exits on its own. */
const STALLED_BUILD = "#!/usr/bin/env node\nsetInterval(() => {}, 60_000);\n";

const ONE_CASE_ONE_PAGE = { cases: ["kitchen-sink"], pages: 1 };

describe(SuiteHarness, () => {
	let temporary: string;
	let fixtures: string;

	beforeEach(() => {
		fixtures = mkdtempSync(join(tmpdir(), "trunk-suite-harness-fixtures-"));
		writeFileSync(join(fixtures, "fixtures"), STALLED_BUILD, { mode: 0o755 });
		vi.stubEnv("TRUNK_FIXTURES", join(fixtures, "fixtures"));

		temporary = mkdtempSync(join(tmpdir(), "trunk-suite-harness-"));
		vi.stubEnv("TMPDIR", temporary);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		chmodSync(temporary, 0o700);
		for (const pid of processesNaming(temporary))
			process.kill(Number(pid), "SIGKILL");
		rmSync(temporary, { recursive: true, force: true });
		rmSync(fixtures, { recursive: true, force: true });
	});

	describe("when torn down while its fixture builds run", () => {
		test("leaves no fixture repositories or builds behind", async () => {
			const suite = new SuiteHarness();
			void suite.start(ONE_CASE_ONE_PAGE);

			await suite.teardown();

			expect(fixtureRepositoriesIn(temporary)).toEqual([]);
			expect(processesNaming(temporary)).toEqual([]);
		});

		test("rejects the start it stopped", async () => {
			const suite = new SuiteHarness();
			const starting = suite.start(ONE_CASE_ONE_PAGE);

			await suite.teardown();

			await expect(starting).rejects.toBeInstanceOf(DOMException);
			await expect(starting).rejects.toHaveProperty("name", "AbortError");
		});

		test("fails when it cannot delete the fixture repositories", async () => {
			const suite = new SuiteHarness();
			void suite.start(ONE_CASE_ONE_PAGE);
			chmodSync(temporary, 0o500);

			await expect(suite.teardown()).rejects.toBeInstanceOf(AggregateError);
		});
	});
});

function fixtureRepositoriesIn(directory: string): string[] {
	return readdirSync(directory).filter((entry) =>
		entry.startsWith("trunk-visual-"),
	);
}

function processesNaming(directory: string): string[] {
	const found = spawnSync("pgrep", ["-f", directory], { encoding: "utf8" });
	if (found.status === 1) return [];
	if (found.status !== 0) throw new Error(`pgrep failed: ${found.stderr}`);

	return found.stdout.split("\n").filter(Boolean);
}
