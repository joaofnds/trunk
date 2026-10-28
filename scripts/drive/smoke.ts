#!/usr/bin/env bun
/**
 * The drive route's walking skeleton, end to end: a drive instance started on a
 * copy of a fixture repository shows the commits git lists, read back through
 * the socket alone. Run by `just drive-smoke`.
 *
 * Usage: bun scripts/drive/smoke.ts <drive binary> <fixture repository>
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRows, launch, request } from "./client.js";

const DEADLINE_MS = 60_000;

const [binary, fixture] = process.argv.slice(2);
if (!binary || !fixture) {
	console.error("usage: bun scripts/drive/smoke.ts <binary> <fixture>");
	process.exit(2);
}

const repo = join(mkdtempSync(join(tmpdir(), "trunk-drive-repo-")), "repo");
cpSync(fixture, repo, { recursive: true });
const expected = execFileSync("git", ["log", "--all", "--format=%s"], {
	cwd: repo,
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean)
	.sort();

const instance = await launch(binary, repo, DEADLINE_MS);
try {
	const shown = (await commitRows(instance, DEADLINE_MS)).sort();

	if (JSON.stringify(shown) !== JSON.stringify(expected)) {
		console.error(`expected ${JSON.stringify(expected)}`);
		console.error(`shown    ${JSON.stringify(shown)}`);
		process.exit(1);
	}
	console.log(`ok: the graph shows ${shown.length} commits (${instance.dir})`);
} finally {
	await request(instance, { op: "quit" }, DEADLINE_MS);
}
