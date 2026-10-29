#!/usr/bin/env bun
/**
 * The drive route's native paths, each on its own, on one drive instance. The
 * app menu bar's Edit > Find opens the history search bar. Delete, chosen from
 * the context menu of a branch a linked worktree is rebasing, shows a dialog
 * naming that worktree with OK as its only button, and OK leaves the branch.
 * Open Repository, answered with a path, opens that repository's commits. The
 * instance never becomes the active application. Run by `just drive-native`.
 *
 * Usage: bun scripts/drive/native.ts <drive binary> <fixture repository> <activation logger>
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callHook,
	DriveError,
	type Instance,
	launch,
	request,
	until,
} from "./client.js";
import { activatedAmong, activationLog, check, gitLog } from "./scenario.js";

const DEADLINE_MS = 60_000;
/** How many times a request asks for a dialog that the app shows a moment
 *  after the choice that opens it. */
const DIALOG_ASKS = 200;

const [binary, fixture, logger] = process.argv.slice(2);
if (!binary || !fixture || !logger) {
	console.error(
		"usage: bun scripts/drive/native.ts <binary> <fixture> <logger>",
	);
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "trunk-drive-native-"));
const repo = join(work, "repo");
const worktree = join(work, "worktree");
const other = join(work, "other");
seedRebasingWorktree();
cpSync(fixture, other, { recursive: true });

const activations = await activationLog(logger);
let instance: Instance | null = null;
try {
	instance = await launch(binary, repo, DEADLINE_MS);
	await until(
		instance,
		`window.__trunkDrive.list("button").includes("Commit") || null`,
		DEADLINE_MS,
	);

	await deleteTheRebasingBranch(instance);
	await openAnotherRepository(instance);
	// Last, since the search field it focuses swallows the picker's Meta+R.
	await findFromTheMenuBar(instance);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	if (instance) {
		try {
			await request(instance, { op: "quit" }, DEADLINE_MS);
		} catch (error) {
			console.error(`${instance.dir} did not quit: ${error}`);
			process.exitCode = 1;
		}
	}
	activations.process.kill();
}

const pid = instance
	? readFileSync(join(instance.dir, "listening"), "utf8").trim()
	: "";
const activated = activatedAmong(activations.lines, [pid]);
check(
	activated.length === 0,
	`the instance never became active (${activations.lines.length - 1} other activations)`,
	`the instance (pid ${pid}) became active: ${activated.join("; ")}\n${activations.lines.join("\n")}`,
);

if (process.exitCode === 1) {
	console.error(`kept for inspection: ${work} and ${instance?.dir}`);
} else {
	if (instance) rmSync(instance.dir, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
}

/** A repository whose branch `feature` is checked out in a linked worktree
 *  stopped partway through an interactive rebase. */
function seedRebasingWorktree(): void {
	git(work, "init", "--quiet", "--initial-branch=main", repo);
	writeFileSync(join(repo, "f"), "a\n");
	git(repo, "add", "f");
	git(repo, "commit", "--quiet", "-m", "base");
	git(repo, "branch", "feature");
	git(repo, "worktree", "add", "--quiet", worktree, "feature");
	writeFileSync(join(worktree, "g"), "c\n");
	git(worktree, "add", "g");
	git(worktree, "commit", "--quiet", "-m", "feature one");
	execFileSync("git", ["rebase", "--quiet", "--interactive", "HEAD"], {
		cwd: worktree,
		env: { ...process.env, GIT_SEQUENCE_EDITOR: "echo break >" },
	});
}

async function findFromTheMenuBar(instance: Instance): Promise<void> {
	const searching = `window.__trunkDrive.list("textbox").includes("Search commits…")`;
	const before = await until(instance, `String(${searching})`, DEADLINE_MS);

	await request(
		instance,
		{ op: "menu-bar", path: ["Edit", "Find"] },
		DEADLINE_MS,
	);

	await until(instance, `${searching} || null`, DEADLINE_MS);
	check(
		before === "false",
		"Edit > Find from the menu bar opens the history search bar",
		"the history search bar was open before Edit > Find was chosen",
	);

	const missing = await failureOf(
		request(instance, { op: "menu-bar", path: ["Edit", "Nope"] }, DEADLINE_MS),
	);
	await request(instance, { op: "ping" }, DEADLINE_MS);
	check(
		missing === "no menu bar item titled Nope",
		"a menu bar item that does not exist is refused by name, and the instance keeps answering",
		`choosing Edit > Nope answered: ${missing}`,
	);
}

async function deleteTheRebasingBranch(instance: Instance): Promise<void> {
	await callHook(
		instance,
		"context",
		["button", "feature", "complementary"],
		DEADLINE_MS,
	);
	await callHook(instance, "choose", ["Delete"], DEADLINE_MS);

	const dialog = await showingDialog(instance);
	const path = execFileSync("realpath", [worktree], {
		encoding: "utf8",
	}).trim();
	check(
		dialog.texts.some((text) => text.includes(path)) &&
			JSON.stringify(dialog.buttons) === '["OK"]',
		`Delete shows a dialog naming the worktree at ${path}, with OK as its only button`,
		`the dialog showed ${JSON.stringify(dialog)}`,
	);

	await request(instance, { op: "press", button: "OK" }, DEADLINE_MS);
	const branches = git(repo, "branch", "--list", "--format=%(refname:short)");
	check(
		branches.split("\n").includes("feature"),
		"after OK, git branch --list still lists feature",
		`git branch --list shows ${JSON.stringify(branches)}`,
	);
}

async function openAnotherRepository(instance: Instance): Promise<void> {
	await callHook(instance, "key", ["Meta+r"], DEADLINE_MS);
	await callHook(
		instance,
		"click",
		["button", "Open Repository", "dialog"],
		DEADLINE_MS,
	);
	await until(instance, "window.__trunkDrive.picker()", DEADLINE_MS);
	await callHook(instance, "pick", [other], DEADLINE_MS);

	const expected = gitLog(other).sort();
	const shown = await until(
		instance,
		`(() => {
			const rows = [...document.querySelectorAll('[data-testid="commit-row-summary"]')]
				.map((cell) => cell.textContent.trim()).sort();
			return JSON.stringify(rows) === ${JSON.stringify(JSON.stringify(expected))} ? rows : null;
		})()`,
		DEADLINE_MS,
	);
	check(
		Array.isArray(shown),
		`Open Repository answered with ${other} shows its ${expected.length} commits`,
		`the graph shows ${JSON.stringify(shown)}`,
	);
}

interface Dialog {
	texts: string[];
	buttons: string[];
}

/** The dialog the app shows, asked for until it appears, since the choice that
 *  opens it returns before the app has drawn it. */
async function showingDialog(instance: Instance): Promise<Dialog> {
	for (let ask = 0; ask < DIALOG_ASKS; ask++) {
		try {
			return (await request(instance, { op: "alert" }, DEADLINE_MS)) as Dialog;
		} catch (error) {
			if (!(error instanceof DriveError)) throw error;
		}
	}
	throw new Error(`no dialog showed after ${DIALOG_ASKS} asks`);
}

async function failureOf(pending: Promise<unknown>): Promise<string> {
	try {
		await pending;
		return "no failure";
	} catch (error) {
		return error instanceof DriveError ? error.message : `${error}`;
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
