import { listen } from "@tauri-apps/api/event";
import { tick } from "svelte";
import { afterEach, expect, it } from "vitest";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSample,
} from "../../src/lib/perf.js";
import type { RepoChanged } from "../../src/lib/repo-change-subscription.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

afterEach(teardown);
afterEach(disablePerf);

it("checks an unchanged remote through the shared schedule without refreshing repository readers", async () => {
	const app = await setup({
		fetchIntervalMs: 60_000,
		repo: {
			steps: [
				{ step: "file", path: "readme", content: "hello" },
				{ step: "commit", message: "Initial" },
				{ step: "remote", name: "origin" },
				{ step: "push", remote: "origin", branch: "main" },
				{
					step: "remoteCommit",
					remote: "origin",
					branch: "main",
					path: "readme",
					content: "remote edit",
					message: "Remote update",
				},
			],
		},
	});
	await app.repo.open();
	app.window.blur();
	await app.events.windowFocusChanged(false);
	await app.settled();
	const count = (command: string) =>
		app.invokes().filter(({ cmd }) => cmd === command).length;
	const commands = [
		"refresh_commit_graph",
		"get_status",
		"get_dirty_counts",
		"get_wip_diff_stats",
		"list_stashes",
	];
	const beforeMetadata = commands.map(count);
	const changes: RepoChanged[] = [];
	const unlisten = await listen<RepoChanged>("repo-changed", (event) => {
		changes.push(event.payload);
	});
	// Publish a remote update first, then check those same refs again through
	// the complete application.
	app.window.focus();
	await app.events.windowFocusChanged(true);
	app.advanceBy(60_000);
	await waitFor("the initial automatic check", () =>
		count("git_fetch_background") === 1 ? true : null,
	);
	app.window.blur();
	await app.events.windowFocusChanged(false);
	await app.settled();
	unlisten();
	expect(changes).toEqual([
		expect.objectContaining({ repo: app.repo.path, refs_only: true }),
	]);
	expect(app.repo.commitRows()).toContain("Remote update");
	expect(commands.map(count)).toEqual(beforeMetadata);
	const before = commands.map(count);
	const samples: PerfSample[] = [];
	enablePerf({
		sink: {
			async write(lines) {
				samples.push(...lines.map((line) => JSON.parse(line)));
			},
		},
		now: () => 0,
		frames: false,
	});
	app.advanceBy(180_000);
	await tick();
	expect(count("git_fetch_background")).toBe(1);
	app.window.focus();
	await app.events.windowFocusChanged(true);
	await tick();
	app.advanceBy(0);
	await waitFor("one overdue automatic check", () =>
		count("git_fetch_background") === 2 ? true : null,
	);
	app.window.blur();
	await app.events.windowFocusChanged(false);
	await app.settled();
	expect(commands.map(count)).toEqual(before);
	expect(count("git_fetch_background")).toBe(2);
	await flushPerf();
	expect(
		samples
			.filter((sample) => sample.name === "autofetch:outcome")
			.map((sample) => sample.attrs),
	).toEqual([{ outcome: "unchanged", graph_rebuilds: 0, remotes: 1 }]);
});

it("holds automatic checks during a manual fetch and resets their deadline after success", async () => {
	const app = await setup({
		fetchIntervalMs: 60_000,
		repo: {
			steps: [
				{ step: "file", path: "readme", content: "hello" },
				{ step: "commit", message: "Initial" },
				{ step: "remote", name: "origin" },
				{ step: "push", remote: "origin", branch: "main" },
			],
		},
	});
	await app.repo.open();
	const count = (command: string) =>
		app.invokes().filter(({ cmd }) => cmd === command).length;
	const release = app.holdCommand("git_fetch");
	const pullOptions = await waitFor("the enabled pull options", () => {
		const button = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Pull options"]',
		);
		return button && !button.disabled ? button : null;
	});
	pullOptions.click();
	const fetch = await waitFor(
		"the Fetch menu item",
		() =>
			[
				...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
			].find((item) => item.textContent?.trim() === "Fetch") ?? null,
	);
	fetch.click();
	await waitFor("the pending manual fetch", () =>
		count("git_fetch") === 1 && pullOptions.disabled ? true : null,
	);

	await tick();
	app.advanceBy(120_000);
	await tick();
	expect(count("git_fetch_background")).toBe(0);
	release();
	await waitFor("the successful manual fetch", () =>
		app.toasts().includes("Fetched successfully") ? true : null,
	);
	await tick();
	const completedAt = app.scheduler.time;

	app.advanceBy(0);
	await tick();
	expect(count("git_fetch_background")).toBe(0);
	app.advanceBy(59_999);
	await tick();
	expect(count("git_fetch_background")).toBe(0);
	app.advanceBy(1);
	await waitFor("the next scheduled check after manual success", () =>
		count("git_fetch_background") === 1 ? true : null,
	);
	expect(app.scheduler.time - completedAt).toBe(60_000);
	app.window.blur();
	await app.events.windowFocusChanged(false);
	await app.settled();
});
