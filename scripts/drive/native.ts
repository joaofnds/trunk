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
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callHook,
	commitRows,
	DriveError,
	type Instance,
	request,
	until,
} from "./client.js";
import { check, driveScenario, gitLog } from "./scenario.js";

const DEADLINE_MS = 60_000;

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

await driveScenario(
	{ logger, work, deadlineMs: DEADLINE_MS },
	async (launch) => {
		const instance = await launch(binary, repo);
		await until(
			instance,
			`window.__trunkDrive.list("button").includes("Commit") || null`,
			DEADLINE_MS,
		);

		// Delete runs on the launched repository, before Open switches away from
		// it, and Find runs last, since the search field it focuses takes the
		// picker's Meta+R. Each step reports its own failure and the next still
		// runs.
		for (const step of [
			deleteTheRebasingBranch,
			readTheResetSubmenu,
			openAnotherRepository,
			findFromTheMenuBar,
		]) {
			try {
				await step(instance);
			} catch (error) {
				console.error(`${step.name} failed:`, error);
				process.exitCode = 1;
			}
		}
	},
);

/** A repository whose branch `feature` is checked out in a linked worktree
 *  stopped partway through an interactive rebase. Its commits are unsigned,
 *  as the fixture corpus's are, since a signing key's passphrase prompt would
 *  draw on the operator's screen. */
function seedRebasingWorktree(): void {
	git(work, "init", "--quiet", "--initial-branch=main", repo);
	writeFileSync(join(repo, "f"), "a\n");
	git(repo, "add", "f");
	git(repo, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
	git(repo, "branch", "feature");
	git(repo, "worktree", "add", "--quiet", worktree, "feature");
	writeFileSync(join(worktree, "g"), "c\n");
	git(worktree, "add", "g");
	git(
		worktree,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"feature one",
	);
	execFileSync(
		"git",
		[
			"-c",
			"commit.gpgsign=false",
			"rebase",
			"--quiet",
			"--interactive",
			"HEAD",
		],
		{
			cwd: worktree,
			env: { ...process.env, GIT_SEQUENCE_EDITOR: "echo break >" },
		},
	);
}

async function findFromTheMenuBar(instance: Instance): Promise<void> {
	const searching = `window.__trunkDrive.list("textbox").includes("Search commits…")`;
	const before = await until(instance, `String(${searching})`, DEADLINE_MS);

	await request(
		instance,
		{ op: "menu-bar", path: ["Edit", "Find"] },
		DEADLINE_MS,
	);

	check(
		before === "false",
		"the history search bar is closed before Edit > Find is chosen",
		"the history search bar was open before Edit > Find was chosen",
	);
	await until(instance, `${searching} || null`, DEADLINE_MS);
	console.log("ok: Edit > Find from the menu bar opens the history search bar");

	for (const [path, refusal] of [
		[["Edit", "Nope"], "no menu bar item titled Nope"],
		[["Edit"], "Edit opens a submenu; name one of its items too"],
		[
			["Window", "Minimize"],
			"Minimize acts on the screen (performMiniaturize:), which the drive route never does",
		],
	] as const) {
		const answer = await failureOf(
			request(instance, { op: "menu-bar", path }, DEADLINE_MS),
		);
		check(
			answer === refusal,
			`choosing ${path.join(" > ")} from the menu bar is refused: ${refusal}`,
			`choosing ${path.join(" > ")} answered: ${answer}`,
		);
	}
	await request(instance, { op: "ping" }, DEADLINE_MS);
	console.log("ok: the instance keeps answering after the refusals");
}

async function deleteTheRebasingBranch(instance: Instance): Promise<void> {
	await callHook(
		instance,
		"context",
		["button", "feature", "complementary"],
		DEADLINE_MS,
	);
	await callHook(instance, "choose", ["Delete"], DEADLINE_MS);

	const dialog = asDialog(
		await request(instance, { op: "alert" }, DEADLINE_MS),
	);
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

async function readTheResetSubmenu(instance: Instance): Promise<void> {
	const rows = (await callHook(
		instance,
		"list",
		["option"],
		DEADLINE_MS,
	)) as string[];
	const base = rows.find((name) => name.startsWith("base "));
	if (!base) throw new Error(`no commit row named base: ${rows.join("; ")}`);

	await callHook(instance, "context", ["option", base], DEADLINE_MS);
	const shown = (await callHook(instance, "menu", [], DEADLINE_MS)) as {
		label: string;
		submenu?: { label: string }[];
	}[];
	const reset = shown.find((item) => item.label === "Reset...");
	const modes = reset?.submenu?.map((item) => item.label);
	check(
		JSON.stringify(modes) === '["Soft","Mixed","Hard"]',
		"a commit row's menu is read with its Reset... submenu of Soft, Mixed and Hard",
		`the commit row's menu read ${JSON.stringify(shown)}`,
	);
	await callHook(instance, "key", ["Escape"], DEADLINE_MS);
}

async function openAnotherRepository(instance: Instance): Promise<void> {
	await callHook(instance, "key", ["Meta+r"], DEADLINE_MS);
	await callHook(
		instance,
		"click",
		["button", "Open Repository", "dialog"],
		DEADLINE_MS,
	);
	const asked = await callHook(instance, "picker", [], DEADLINE_MS);
	check(
		JSON.stringify(asked) === '{"directory":true,"multiple":false}',
		"Open Repository opens a folder picker for one directory",
		`the picker opened with ${JSON.stringify(asked)}`,
	);
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
	).catch(() => commitRows(instance, DEADLINE_MS));
	check(
		JSON.stringify(shown) === JSON.stringify(expected),
		`Open Repository answered with ${other} shows its ${expected.length} commits`,
		`the graph shows ${JSON.stringify(shown)}, not ${JSON.stringify(expected)}`,
	);
}

interface Dialog {
	readonly texts: readonly string[];
	readonly buttons: readonly string[];
}

/** The alert request's answer, checked to carry the dialog's texts and button
 *  titles, so a changed reply fails by name rather than mid-check. */
function asDialog(reply: unknown): Dialog {
	const { texts, buttons } = (reply ?? {}) as Partial<
		Record<keyof Dialog, unknown>
	>;
	if (!isStrings(texts) || !isStrings(buttons)) {
		throw new Error(`the alert request answered ${JSON.stringify(reply)}`);
	}
	return { texts, buttons };
}

function isStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
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
