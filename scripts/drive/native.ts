#!/usr/bin/env bun
/**
 * The drive route's native paths, each on its own, on one drive instance. The
 * app menu bar's Edit > Find opens the history search bar. Delete, chosen from
 * the context menu of a branch a linked worktree is rebasing, names that worktree
 * in a refusal. Deleting a spare branch opens a native confirmation to cancel.
 * Cmd+Z, pressed through AppKit's key path, undoes the last commit, and
 * Cmd+Shift+Z redoes it, which only holds while the page meets those keys
 * before the Edit menu's own Undo and Redo do. Cmd+Q through the same path is
 * refused, since the page would pass it on to Quit.
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
	evaluate,
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
			undoAndRedoFromTheKeyboard,
			readTheResetSubmenu,
			findInNarrowCommitPane,
			openAnotherRepository,
			findInDiffKeepsItsViewport,
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
 *  stopped partway through an interactive rebase, and whose `main` is a
 *  commit ahead of it, since Undo refuses a root commit. Its commits are unsigned,
 *  as the fixture corpus's are, since a signing key's passphrase prompt would
 *  draw on the operator's screen. */
function seedRebasingWorktree(): void {
	git(work, "init", "--quiet", "--initial-branch=main", repo);
	writeFileSync(join(repo, "f"), "a\n");
	git(repo, "add", "f");
	git(repo, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
	git(repo, "branch", "feature");
	git(repo, "branch", "spare");
	writeFileSync(join(repo, "f"), "b\n");
	git(
		repo,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-am",
		"main one",
	);
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

async function findInDiffKeepsItsViewport(instance: Instance): Promise<void> {
	const name = "find-overlay.txt";
	const line = `${"x".repeat(90)}needle`;
	writeFileSync(
		join(other, name),
		[`first ${line}`, ...Array<string>(160).fill("body"), `last ${line}`].join(
			"\n",
		),
	);
	await until(
		instance,
		`document.querySelector('[data-path="${name}"]') !== null`,
		DEADLINE_MS,
	);
	await evaluate(
		instance,
		`document.querySelector('[data-path="${name}"]').click()`,
		DEADLINE_MS,
	);

	const viewport = `document.querySelector('[data-testid="diff-viewport"]')`;
	try {
		await until(
			instance,
			`${viewport}?.scrollHeight > ${viewport}?.clientHeight`,
			DEADLINE_MS,
		);
		await evaluate(
			instance,
			`${viewport}.scrollTop = ${viewport}.scrollHeight`,
			DEADLINE_MS,
		);
		const geometry = `(() => {
			const view = ${viewport};
			const { top, height } = view.getBoundingClientRect();
			return JSON.stringify([top, height, view.scrollTop]);
		})()`;
		const before = await until(
			instance,
			`${viewport}.scrollTop > 0 && ${geometry}`,
			DEADLINE_MS,
		);
		await request(instance, { op: "chord", chord: "Meta+f" }, DEADLINE_MS);
		await until(
			instance,
			'document.activeElement.placeholder === "Find in diff…"',
			DEADLINE_MS,
		);
		const after = await evaluate(instance, geometry, DEADLINE_MS);
		check(
			before === after,
			"opening Find preserves the scrolled diff viewport",
			`opening Find changed [top, height, scrollTop] from ${before} to ${after}`,
		);
		const overCode = await evaluate(
			instance,
			`(() => {
			const rect = document.activeElement.getBoundingClientRect();
			const view = ${viewport}.getBoundingClientRect();
			return rect.left >= view.left && rect.right <= view.right && rect.top >= view.top && rect.bottom <= view.bottom;
		})()`,
			DEADLINE_MS,
		);
		check(
			overCode === true,
			"the Find field floats within the diff",
			"the Find field is outside the diff",
		);

		await callHook(
			instance,
			"type",
			["textbox", "Find in diff…", "needle"],
			DEADLINE_MS,
		);
		const exposed = (rowLabel: string) => `(() => {
			const mark = document.querySelector("[data-diff-match]");
			if (!mark?.closest("[data-line-index]")?.textContent.includes(${JSON.stringify(rowLabel)})) return false;
			const rect = mark.getBoundingClientRect();
			return mark.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
		})()`;
		await until(instance, exposed("first"), DEADLINE_MS);
		await callHook(instance, "key", ["Enter"], DEADLINE_MS);
		await until(instance, exposed("last"), DEADLINE_MS);
		console.log("ok: the first and last occurrences are visible beside Find");
	} finally {
		await callHook(instance, "click", ["button", "Close diff"], DEADLINE_MS);
	}
}

async function findInNarrowCommitPane(instance: Instance): Promise<void> {
	const detail = `document.querySelector('[data-testid="commit-detail"]')`;
	const splitter = `document.querySelector('[aria-label="Resize detail pane"]')`;
	const oid = git(repo, "rev-parse", "--short=7", "HEAD");
	await until(
		instance,
		`(() => {
			const cells = document.querySelectorAll('[role="option"] [data-column="sha"]');
			const cell = [...cells].find(cell => cell.textContent.trim() === ${JSON.stringify(oid)});
			if (!cell) return false;
			cell.closest('[role="option"]').click();
			return true;
		})()`,
		DEADLINE_MS,
	);
	await until(instance, `${detail} !== null`, DEADLINE_MS);
	try {
		await evaluate(instance, `${splitter}.focus()`, DEADLINE_MS);
		// Ten 8px arrow steps take the default 280px pane to its 200px floor.
		for (let step = 0; step < 10; step++)
			await callHook(instance, "key", ["ArrowRight"], DEADLINE_MS);
		await until(instance, `${detail}.clientWidth === 200`, DEADLINE_MS);
		await callHook(
			instance,
			"click",
			["button", "Find in commit message"],
			DEADLINE_MS,
		);
		await callHook(
			instance,
			"type",
			["textbox", "Find in commit message…", "reconciliation"],
			DEADLINE_MS,
		);
		const fits = await evaluate(
			instance,
			`(() => {
			const input = ${detail}.querySelector('search input');
			const sha = ${detail}.querySelector('button[title="Copy SHA"]');
			const rect = sha.getBoundingClientRect();
			const y = rect.top + rect.height / 2;
			return input.scrollWidth <= input.clientWidth &&
				[rect.left + 1, rect.right - 1].every(x => sha.contains(document.elementFromPoint(x, y)));
		})()`,
			DEADLINE_MS,
		);
		check(
			fits === true,
			"the narrow commit pane shows the query and complete SHA",
			"the query or SHA is clipped at the detail pane minimum",
		);
	} finally {
		await evaluate(instance, `${splitter}.focus()`, DEADLINE_MS);
		for (let step = 0; step < 10; step++)
			await callHook(instance, "key", ["ArrowLeft"], DEADLINE_MS);
		await callHook(
			instance,
			"click",
			["button", "Close commit detail"],
			DEADLINE_MS,
		);
	}
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

	const path = execFileSync("realpath", [worktree], {
		encoding: "utf8",
	}).trim();
	const refusal = `Cannot delete 'feature' while the worktree at ${path} is rebasing it.`;
	await until(
		instance,
		`[...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes(${JSON.stringify(refusal)}))`,
		DEADLINE_MS,
	);
	check(
		git(repo, "branch", "--list", "feature").trim() !== "",
		"Delete identifies the rebasing worktree and leaves its branch",
		"Delete removed the branch held by the rebase",
	);

	await callHook(
		instance,
		"context",
		["button", "spare", "complementary"],
		DEADLINE_MS,
	);
	await callHook(instance, "choose", ["Delete"], DEADLINE_MS);
	const dialog = asDialog(
		await request(instance, { op: "alert" }, DEADLINE_MS),
	);
	check(
		dialog.texts.some((text) => text.includes("spare")) &&
			dialog.buttons.includes("Delete"),
		"Delete asks for confirmation for the unheld branch",
		`the dialog showed ${JSON.stringify(dialog)}`,
	);
	await request(instance, { op: "press", button: "Cancel" }, DEADLINE_MS);
	check(
		git(repo, "branch", "--list", "spare").trim() !== "",
		"Cancel leaves the branch in place",
		"Cancel removed the spare branch",
	);
}

async function undoAndRedoFromTheKeyboard(instance: Instance): Promise<void> {
	const head = git(repo, "rev-parse", "HEAD");
	const parent = git(repo, "rev-parse", "HEAD~1");
	await until(instance, toolbarButtonEnabled("Undo"), DEADLINE_MS);

	await request(instance, { op: "chord", chord: "Meta+z" }, DEADLINE_MS);
	// The parent is a root commit, which Undo refuses, so Undo going off shows
	// the toolbar has read where HEAD went.
	await until(
		instance,
		`${toolbarButtonEnabled("Redo")} && !(${toolbarButtonEnabled("Undo")})`,
		DEADLINE_MS,
	);
	const undone = git(repo, "rev-parse", "HEAD");
	check(
		undone === parent,
		"Cmd+Z moves HEAD from main one back to its parent",
		`after Cmd+Z HEAD is ${undone}, not the parent ${parent}`,
	);

	await request(instance, { op: "chord", chord: "Meta+Shift+z" }, DEADLINE_MS);
	// Redo drops its button as it starts, and Undo returns once HEAD is back on
	// a commit it can undo.
	await until(instance, toolbarButtonEnabled("Undo"), DEADLINE_MS);
	const redone = git(repo, "rev-parse", "HEAD");
	check(
		redone === head,
		"Cmd+Shift+Z puts HEAD back on main one",
		`after Cmd+Shift+Z HEAD is ${redone}, not main one at ${head}`,
	);

	const quit = await failureOf(
		request(instance, { op: "chord", chord: "Meta+q" }, DEADLINE_MS),
	);
	await request(instance, { op: "ping" }, DEADLINE_MS);
	check(
		/^Trunk > Quit .+ owns that chord/.test(quit),
		"Cmd+Q through chord is refused, since the page would pass it on to Quit, and the instance keeps answering",
		`Cmd+Q through chord answered: ${quit}`,
	);
}

/** An expression for whether the toolbar's button named `name` is enabled. */
function toolbarButtonEnabled(name: string): string {
	return `document.querySelector('[aria-label="${name}"]')?.disabled === false`;
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
