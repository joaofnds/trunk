#!/usr/bin/env bun
/**
 * Bumps the four version manifests in lockstep for `just release <version>`.
 *
 * Usage:
 *   bun run scripts/release-apply.ts <version>
 *
 * Refuses a version that is not a strict increment over the newest release tag,
 * or over tauri.conf.json's version on a repository with no release tags yet.
 * Writes package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock and
 * src-tauri/tauri.conf.json; the justfile recipe stages, commits and tags.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
	bumpCargoLock,
	bumpCargoToml,
	bumpPackageJson,
	bumpTauriConf,
	currentVersion,
	ReleaseError,
	releaseBaseline,
	requireIncrement,
} from "./release.js";

const PACKAGE_JSON = "package.json";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "src-tauri/Cargo.lock";
const TAURI_CONF = "src-tauri/tauri.conf.json";

const version = process.argv[2];

if (!version) {
	console.error("usage: bun run scripts/release-apply.ts <version>");
	process.exit(2);
}

try {
	const tauriConf = readFileSync(TAURI_CONF, "utf8");
	const tags = execFileSync("git", ["tag", "--list", "v*"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);
	requireIncrement(releaseBaseline(currentVersion(tauriConf), tags), version);

	writeFileSync(TAURI_CONF, bumpTauriConf(tauriConf, version));
	writeFileSync(
		PACKAGE_JSON,
		bumpPackageJson(readFileSync(PACKAGE_JSON, "utf8"), version),
	);
	writeFileSync(
		CARGO_TOML,
		bumpCargoToml(readFileSync(CARGO_TOML, "utf8"), version),
	);
	writeFileSync(
		CARGO_LOCK,
		bumpCargoLock(readFileSync(CARGO_LOCK, "utf8"), version),
	);
} catch (error) {
	if (error instanceof ReleaseError) {
		console.error(`release: ${error.message}`);
		process.exit(1);
	}

	throw error;
}
