#!/usr/bin/env bun
/**
 * Prints the version a `major`, `minor` or `patch` bump would release, for
 * `just release-{major,minor,patch}`.
 *
 * Usage:
 *   bun run scripts/release-next.ts <major | minor | patch>
 *
 * The baseline is the newest release tag, falling back to tauri.conf.json's
 * version on a repository with no release tags yet — the same baseline
 * release-apply.ts validates against, so a version printed here is one
 * `just release` accepts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	currentVersion,
	nextVersion,
	ReleaseError,
	releaseBaseline,
} from "./release.js";

const TAURI_CONF = "src-tauri/tauri.conf.json";

const level = process.argv[2];

if (!level) {
	console.error(
		"usage: bun run scripts/release-next.ts <major | minor | patch>",
	);
	process.exit(2);
}

try {
	const tags = execFileSync("git", ["tag", "--list", "v*"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);
	const baseline = releaseBaseline(
		currentVersion(readFileSync(TAURI_CONF, "utf8")),
		tags,
	);

	console.log(nextVersion(baseline, level));
} catch (error) {
	if (error instanceof ReleaseError) {
		console.error(`release: ${error.message}`);
		process.exit(1);
	}

	throw error;
}
