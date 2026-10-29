#!/usr/bin/env bun
/**
 * Drives a drive instance of Trunk, built by `just drive-build`, from a shell.
 * `launch` prints the instance's directory; every other
 * verb reads it from TRUNK_DRIVE_DIR.
 *
 * Usage:
 *   bun scripts/drive/drive.ts launch <binary> <repository>
 *   bun scripts/drive/drive.ts ping | rows | alert | quit
 *   bun scripts/drive/drive.ts eval <expression>
 *   bun scripts/drive/drive.ts until <expression>
 *   bun scripts/drive/drive.ts invoke <command> [<json arguments>]
 *   bun scripts/drive/drive.ts snapshot <png path>
 *   bun scripts/drive/drive.ts press <button title>
 *   bun scripts/drive/drive.ts menu
 *   bun scripts/drive/drive.ts choose <menu item label>
 */

import { resolve } from "node:path";
import {
	commitRows,
	evaluate,
	instanceAt,
	invoke,
	launch,
	request,
	until,
} from "./client.js";

const DEADLINE_MS = 60_000;

const [verb, ...rest] = process.argv.slice(2);

function instance() {
	const dir = process.env.TRUNK_DRIVE_DIR;
	if (!dir)
		throw new Error("set TRUNK_DRIVE_DIR to the directory launch printed");
	return instanceAt(dir);
}

async function run(): Promise<unknown> {
	switch (verb) {
		case "launch": {
			const [binary, repo] = rest;
			const launched = await launch(
				resolve(binary),
				resolve(repo),
				DEADLINE_MS,
			);
			return launched.dir;
		}
		case "ping": {
			const started = performance.now();
			await request(instance(), { op: "ping" }, DEADLINE_MS);
			return `${(performance.now() - started).toFixed(2)}ms`;
		}
		case "rows":
			return commitRows(instance(), DEADLINE_MS);
		case "eval":
			return evaluate(instance(), rest.join(" "), DEADLINE_MS);
		case "until":
			return until(instance(), rest.join(" "), DEADLINE_MS);
		case "invoke":
			return invoke(
				instance(),
				rest[0],
				JSON.parse(rest[1] ?? "{}"),
				DEADLINE_MS,
			);
		case "snapshot":
			return request(
				instance(),
				{ op: "snapshot", path: resolve(rest[0]) },
				DEADLINE_MS,
			);
		case "alert":
			return request(instance(), { op: "alert" }, DEADLINE_MS);
		case "press":
			return request(
				instance(),
				{ op: "press", button: rest.join(" ") },
				DEADLINE_MS,
			);
		case "menu":
			return evaluate(instance(), "window.__trunkDrive.menu()", DEADLINE_MS);
		case "choose":
			return evaluate(
				instance(),
				`window.__trunkDrive.choose(${JSON.stringify(rest.join(" "))})`,
				DEADLINE_MS,
			);
		case "quit":
			return request(instance(), { op: "quit" }, DEADLINE_MS);
		default:
			console.error(
				"usage: drive.ts launch|ping|rows|eval|until|invoke|snapshot|alert|press|menu|choose|quit",
			);
			process.exit(2);
	}
}

const value = await run();
console.log(
	typeof value === "string"
		? // Page text can hold a commit summary's escape bytes, which would drive the terminal.
			Array.from(value, (c) => {
				const code = c.charCodeAt(0);
				const control =
					(code < 0x20 && c !== "\n" && c !== "\t") || code === 0x7f;
				return control ? `\\u${code.toString(16).padStart(4, "0")}` : c;
			}).join("")
		: JSON.stringify(value),
);
