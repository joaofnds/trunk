#!/usr/bin/env bun
/**
 * Drives a drive instance of Trunk, built by `just drive-build`, from a shell.
 * `launch` prints the instance's directory; every other
 * verb reads it from TRUNK_DRIVE_DIR. A control is named by its role and the
 * name a user reads on it (src/drive-gestures.ts), as `click button Commit`;
 * quote a name or text that holds spaces. A name the page shows twice is
 * told apart by the landmark it sits in, as `--in complementary` for the
 * branch sidebar. A menu item is named by its label
 * and the label of each menu above it, one argument per level, as
 * `choose "Reset..." Soft` or `menu-bar Edit Find`.
 *
 * Usage:
 *   bun scripts/drive/drive.ts launch <binary> <repository>
 *   bun scripts/drive/drive.ts ping | rows | alert | drawing | quit
 *   bun scripts/drive/drive.ts eval <expression>
 *   bun scripts/drive/drive.ts until <expression>
 *   bun scripts/drive/drive.ts invoke <command> [<json arguments>]
 *   bun scripts/drive/drive.ts click <role> <name> [--in <landmark role>]
 *   bun scripts/drive/drive.ts context <role> <name> [--in <landmark role>]
 *   bun scripts/drive/drive.ts type <role> <name> <text> [--in <landmark role>]
 *   bun scripts/drive/drive.ts key <key, as Escape or Meta+Enter>
 *   bun scripts/drive/drive.ts list <role>
 *   bun scripts/drive/drive.ts snapshot <png path>
 *   bun scripts/drive/drive.ts press <button title>
 *   bun scripts/drive/drive.ts menu
 *   bun scripts/drive/drive.ts choose <label> [<label of the item in its submenu>...]
 *   bun scripts/drive/drive.ts menu-bar <menu title> <item title> [...]
 *   bun scripts/drive/drive.ts picker | dismiss-picker
 *   bun scripts/drive/drive.ts pick <path>
 */

import { resolve } from "node:path";
import {
	callHook,
	commitRows,
	evaluate,
	instanceAt,
	invoke,
	launch,
	request,
	until,
} from "./client.js";
import {
	type CommandLine,
	hookArguments,
	parse,
	UsageError,
} from "./command-line.js";

const DEADLINE_MS = 60_000;

let line: CommandLine;
try {
	line = parse(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	console.error(error.message);
	process.exit(2);
}
const { verb, words: rest } = line;

function instance() {
	const dir = process.env.TRUNK_DRIVE_DIR;
	if (!dir)
		throw new UsageError("set TRUNK_DRIVE_DIR to the directory launch printed");
	return instanceAt(dir);
}

function hook(
	name: keyof Window["__trunkDrive"],
	count: number,
): Promise<unknown> {
	return callHook(instance(), name, hookArguments(line, count), DEADLINE_MS);
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
		case "click":
			return hook("click", 2);
		case "context":
			return hook("context", 2);
		case "type":
			return hook("type", 3);
		case "key":
			return hook("key", 1);
		case "list":
			return hook("list", 1);
		case "snapshot":
			return request(
				instance(),
				{ op: "snapshot", path: resolve(rest[0]) },
				DEADLINE_MS,
			);
		case "alert":
			return request(instance(), { op: "alert" }, DEADLINE_MS);
		case "drawing":
			return request(instance(), { op: "drawing" }, DEADLINE_MS);
		case "press":
			return request(
				instance(),
				{ op: "press", button: rest.join(" ") },
				DEADLINE_MS,
			);
		case "menu":
			return hook("menu", 0);
		case "choose":
			return callHook(instance(), "choose", rest, DEADLINE_MS);
		case "menu-bar":
			return request(instance(), { op: "menu-bar", path: rest }, DEADLINE_MS);
		case "picker":
			return hook("picker", 0);
		case "pick": {
			if (rest.length !== 1) {
				throw new UsageError("pick takes 1 argument, the path to answer with");
			}

			return callHook(instance(), "pick", [resolve(rest[0])], DEADLINE_MS);
		}
		case "dismiss-picker":
			return hook("dismissPicker", 0);
		case "quit":
			return request(instance(), { op: "quit" }, DEADLINE_MS);
		default:
			throw new UsageError(
				"usage: drive.ts launch|ping|rows|eval|until|invoke|click|context|type|key|list|snapshot|alert|drawing|press|menu|choose|menu-bar|picker|pick|dismiss-picker|quit",
			);
	}
}

/** Page text can hold a commit summary's escape bytes, C0 and C1 alike, which
 *  would drive the terminal. */
function printable(text: string): string {
	return Array.from(text, (c) => {
		const code = c.charCodeAt(0);
		const control =
			(code < 0x20 && c !== "\n" && c !== "\t") ||
			(code >= 0x7f && code <= 0x9f);
		return control ? `\\u${code.toString(16).padStart(4, "0")}` : c;
	}).join("");
}

try {
	const value = await run();
	console.log(
		printable(typeof value === "string" ? value : JSON.stringify(value)),
	);
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	console.error(error.message);
	process.exit(2);
}
