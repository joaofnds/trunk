import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const pluginDir = resolve(root, "scripts/biome");
const fixtures = join(pluginDir, "__fixtures__");
const biome = resolve(root, "node_modules/.bin/biome");

const PLUGINS = ["color", "type", "length"] as const;

interface Report {
	diagnostics: { severity: string; location: { start: { line: number } } }[];
}

interface Finding {
	severity: string;
	line: number;
}

const configDirs: string[] = [];
afterAll(() => {
	for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
});

/** A config holding only the named plugins, so a run reports their verdict
 *  and nothing from the repository's own biome.json. */
function configFor(plugins: readonly string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "trunk-tokens-"));
	configDirs.push(dir);
	writeFileSync(
		join(dir, "biome.json"),
		JSON.stringify({
			plugins: plugins.map((name) => join(pluginDir, `tokens-${name}.grit`)),
			linter: { rules: { recommended: false } },
			html: { experimentalFullSupportEnabled: true },
		}),
	);
	return dir;
}

function lint(configDir: string, file: string): Finding[] {
	const run = spawnSync(
		biome,
		["lint", "--config-path", configDir, "--reporter=json", file],
		{ encoding: "utf8" },
	);
	if (run.stdout === "") throw new Error(run.stderr);
	const report: Report = JSON.parse(run.stdout);
	return report.diagnostics.map((d) => ({
		severity: d.severity,
		line: d.location.start.line,
	}));
}

/** Every off-token declaration in a fixture opens a `.bad { prop:` line of its
 *  own, so the lines a plugin must report are read off the fixture. */
function badDeclarationLines(file: string): number[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((text, i) => (/^\.bad \{ [a-z-]+:/.test(text) ? [i + 1] : []));
}

function errorsAt(lines: number[]): Finding[] {
	return lines.map((line) => ({ severity: "error", line }));
}

describe.each(PLUGINS)("tokens-%s.grit", (plugin) => {
	const config = configFor([plugin]);

	it("flags every declaration in its bad fixture as an error", () => {
		const bad = join(fixtures, `${plugin}-bad.css`);

		expect(lint(config, bad)).toEqual(errorsAt(badDeclarationLines(bad)));
	});

	it("passes its good fixture", () => {
		expect(lint(config, join(fixtures, `${plugin}-good.css`))).toEqual([]);
	});

	it("passes the token sheet itself", () => {
		expect(lint(config, resolve(root, "src/tokens.css"))).toEqual([]);
	});
});

describe("inside a component's <style> block", () => {
	it("flags the off-token declarations and nothing in the compliant rule", () => {
		const config = configFor(PLUGINS);
		const component = join(fixtures, "scoped.svelte");

		expect(lint(config, component)).toEqual(
			errorsAt(badDeclarationLines(component)),
		);
	});
});
