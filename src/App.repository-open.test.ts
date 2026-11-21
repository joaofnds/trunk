import { fireEvent, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import { _resetToasts, toasts } from "./lib/toast.svelte.js";

const activeTab = { id: "active", repoPath: "/active", repoName: "active" };
const otherTab = { id: "other", repoPath: "/other", repoName: "other" };
const slow = { path: "/slow", name: "slow" };
const fast = { path: "/fast", name: "fast" };
const other = { path: otherTab.repoPath, name: otherTab.repoName };
const openError = { code: "not_a_git_repo", message: "missing repository" };

let app: StartupHarness;

async function start(tabs = [activeTab]) {
	app = new StartupHarness(tabs, activeTab.id);
	app.host.preferences.set("recent_repos", [slow, fast]);
	app.start();
	await screen.findByText("restored history");
	await app.settle();
}

function picker() {
	return screen.queryByRole("dialog", { name: "Open a recent repository" });
}

async function showPicker() {
	await fireEvent.keyDown(window, { key: "r", ctrlKey: true });
	return screen.findByRole("dialog", { name: "Open a recent repository" });
}

async function dismissPicker() {
	const search = screen.getByRole("textbox", {
		name: "Search recent repositories",
	});
	await fireEvent.keyDown(search, { key: "Escape" });
}

afterEach(() => {
	app.teardown();
	_resetToasts();
});

describe("repository opening at the initiating gesture", () => {
	it("keeps a replacement in the same tab when its restored repository fails first", async () => {
		app = new StartupHarness([activeTab, otherTab], activeTab.id);
		app.host.preferences.set("recent_repos", [fast]);
		const restored = app.host.holdNextReply("open_repo");
		const replacement = app.host.holdNextReply("open_repo");
		app.start();
		await restored.entered;

		await app.pickRecent(fast.name);
		expect(await replacement.entered).toEqual({ path: fast.path });
		restored.reject(openError);
		await app.settle();
		replacement.release(null);
		await app.settle();

		expect(
			screen.queryByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
		expect(app.host.preferences.get("open_tabs")).toContainEqual({
			id: activeTab.id,
			repoPath: fast.path,
			repoName: fast.name,
		});
		expect(toasts.items).toEqual([]);
	});

	it("keeps its current tab and Recent order when a selected restoring repository fails", async () => {
		await start([activeTab, otherTab]);
		app.host.preferences.set("recent_repos", [fast, other]);
		const restored = app.host.holdNextReply("open_repo");
		await app.prepareNextRepository();
		await restored.entered;

		await app.pickRecent(other.name);
		await app.settle();
		const beforeReply = screen.queryByRole("tab", {
			name: activeTab.repoName,
			selected: true,
		});
		restored.reject(openError);
		await app.settle();

		expect(beforeReply).toBeInTheDocument();
		expect(app.host.preferences.get("recent_repos")).toEqual([fast, other]);
		expect(app.paths("open_repo")).toEqual([activeTab.repoPath, other.path]);
	});

	it("falls back when both the restored repository and its replacement fail", async () => {
		app = new StartupHarness([activeTab, otherTab], activeTab.id);
		app.host.preferences.set("recent_repos", [slow, fast]);
		const restored = app.host.holdNextReply("open_repo");
		const replacement = app.host.holdNextReply("open_repo");
		app.start();
		await restored.entered;

		await app.pickRecent(fast.name);
		await replacement.entered;
		restored.reject(openError);
		await app.settle();
		replacement.reject(openError);
		await app.settle();

		expect(
			screen.queryByRole("tab", { name: other.name, selected: true }),
		).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: activeTab.repoName })).toBeNull();
		expect(app.host.preferences.get("recent_repos")).toEqual([slow, fast]);
	});

	it("accepts a newer Welcome choice while the first repository is opening", async () => {
		await start();
		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		const welcome = await screen.findByRole("list");
		const first = app.host.holdNextReply("open_repo");

		await fireEvent.click(await within(welcome).findByText(slow.name));
		await first.entered;
		await fireEvent.click(await within(welcome).findByText(fast.name));
		await app.settle();
		first.release(null);
		await app.settle();

		expect(
			screen.queryByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
		expect(app.paths("close_repo")).toEqual([slow.path]);
	});

	it("skips a Welcome folder confirmation superseded by a more recent choice", async () => {
		await start();
		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		const welcome = await screen.findByRole("list");
		app.host.dialog.chooses("/slow/src");
		app.host.dialog.confirms();
		const lookup = app.host.holdNextReply("enclosing_repository");

		await fireEvent.click(
			screen.getByRole("button", { name: "Open Repository" }),
		);
		await lookup.entered;
		await fireEvent.click(await within(welcome).findByText(fast.name));
		await app.settle();
		lookup.release(slow.path);
		await app.settle();

		expect(app.host.dialog.questions).toEqual([]);
		expect(
			screen.queryByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
	});

	it("keeps the newer picker folder when the older lookup finishes first", async () => {
		await start();
		app.host.preferences.set("recent_repos", []);
		const openPicker = await showPicker();
		const openFolder = await within(openPicker).findByRole("button", {
			name: "Open Repository",
		});
		const first = app.host.holdNextReply("enclosing_repository");
		const second = app.host.holdNextReply("enclosing_repository");
		app.host.dialog.confirms();

		app.host.dialog.chooses("/slow/src");
		await fireEvent.click(openFolder);
		await first.entered;
		app.host.dialog.chooses(fast.path);
		await fireEvent.click(openFolder);
		await second.entered;
		first.release(slow.path);
		await app.settle();
		second.release(null);
		await app.settle();

		expect(app.host.dialog.questions).toEqual([]);
		expect(
			screen.queryByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
	});

	it("skips the enclosing-repository confirmation when the picker was dismissed", async () => {
		await start();
		app.host.preferences.set("recent_repos", []);
		const openPicker = await showPicker();
		app.host.dialog.chooses("/slow/src");
		const lookup = app.host.holdNextReply("enclosing_repository");

		await fireEvent.click(
			await within(openPicker).findByRole("button", {
				name: "Open Repository",
			}),
		);
		await lookup.entered;
		await dismissPicker();
		lookup.release(slow.path);
		await app.settle();

		expect(app.host.dialog.questions).toEqual([]);
		expect(
			screen.queryByRole("tab", { name: activeTab.repoName, selected: true }),
		).toBeInTheDocument();
	});

	it("reports the current folder lookup failure in the picker and leaves it open", async () => {
		await start();
		app.host.preferences.set("recent_repos", []);
		const openPicker = await showPicker();
		app.host.dialog.chooses("/slow/src");
		const lookup = app.host.holdNextReply("enclosing_repository");

		await fireEvent.click(
			await within(openPicker).findByRole("button", {
				name: "Open Repository",
			}),
		);
		await lookup.entered;
		lookup.reject({ code: "spawn_error", message: "the lookup stopped" });
		await app.settle();

		expect(picker()).toBeInTheDocument();
		expect(toasts.items).toContainEqual(
			expect.objectContaining({
				message: "Could not open src: the lookup stopped",
				kind: "error",
			}),
		);
	});

	it("reports a current Welcome open failure and leaves its tab selected", async () => {
		await start();
		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		const welcome = await screen.findByRole("list");
		const opening = app.host.holdNextReply("open_repo");

		await fireEvent.click(await within(welcome).findByText(slow.name));
		await opening.entered;
		opening.reject(openError);
		await app.settle();

		expect(screen.getByText(openError.message)).toBeInTheDocument();
		expect(
			screen.queryByRole("tab", { name: "New Tab", selected: true }),
		).toBeInTheDocument();
	});
});

describe("opening a recent repository", () => {
	it("keeps the latest choice when the earlier repository opens last", async () => {
		await start();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent(slow.name);
		expect(await opening.entered).toEqual({ path: slow.path });
		expect(screen.getByText(`Opening ${slow.name}…`)).toBeInTheDocument();
		await app.pickRecent(fast.name);
		await screen.findByRole("tab", { name: fast.name, selected: true });
		opening.release(null);
		await app.settle();

		expect(
			screen.getByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
		expect(app.paths("get_commit_graph")).toEqual([
			activeTab.repoPath,
			fast.path,
		]);
		expect(app.paths("close_repo")).toEqual([activeTab.repoPath, slow.path]);
		expect(app.host.preferences.get("recent_repos")).toEqual([fast, slow]);
	});

	it("opens in the tab that started the picker and leaves the later tab selection active", async () => {
		await start([activeTab, otherTab]);
		await app.prepareNextRepository();
		const openPicker = await showPicker();

		await fireEvent.keyDown(openPicker, { key: "Tab", ctrlKey: true });
		await screen.findByRole("tab", { name: otherTab.repoName, selected: true });
		await app.pickRecent(fast.name);
		await app.settle();

		expect(
			screen.getByRole("tab", { name: otherTab.repoName, selected: true }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: fast.name, selected: false }),
		).toBeInTheDocument();
		expect(app.paths("get_commit_graph")).toEqual([
			activeTab.repoPath,
			otherTab.repoPath,
		]);
	});

	it("closes an unused repository when its initiating tab closes during the open", async () => {
		await start();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent(slow.name);
		expect(await opening.entered).toEqual({ path: slow.path });
		await fireEvent.keyDown(screen.getByRole("dialog"), {
			key: "w",
			metaKey: true,
		});
		opening.release(null);
		await app.settle();

		expect(
			screen.getByRole("tab", { name: "New Tab", selected: true }),
		).toBeInTheDocument();
		expect(app.paths("get_commit_graph")).toEqual([activeTab.repoPath]);
		expect(app.paths("close_repo")).toEqual([activeTab.repoPath, slow.path]);
	});

	it("shares an overlapping open with another tab when the first tab closes", async () => {
		await start([activeTab, otherTab]);
		await app.prepareNextRepository();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent(slow.name);
		expect(await opening.entered).toEqual({ path: slow.path });
		await fireEvent.keyDown(screen.getByRole("dialog"), {
			key: "w",
			metaKey: true,
		});
		await app.pickRecent(slow.name);
		opening.release(null);
		await app.settle();

		expect(
			screen.getByRole("tab", { name: slow.name, selected: true }),
		).toBeInTheDocument();
		expect(app.paths("open_repo")).toEqual([
			activeTab.repoPath,
			otherTab.repoPath,
			slow.path,
		]);
		expect(app.paths("close_repo")).not.toContain(slow.path);
	});

	it("keeps the old repository when Escape cancels an open", async () => {
		await start();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent(slow.name);
		expect(await opening.entered).toEqual({ path: slow.path });
		await dismissPicker();
		opening.release(null);
		await app.settle();

		expect(
			screen.queryByRole("tab", { name: activeTab.repoName, selected: true }),
		).toBeInTheDocument();
		expect(app.paths("close_repo")).toEqual([slow.path]);
	});

	it("remembers repositories in choice order when they open in different tabs", async () => {
		await start();
		await fireEvent.click(screen.getByRole("button", { name: "New tab" }));
		const welcome = await screen.findByRole("list");
		const opening = app.host.holdNextReply("open_repo");

		await fireEvent.click(await within(welcome).findByText(slow.name));
		expect(await opening.entered).toEqual({ path: slow.path });
		await app.activate(activeTab.repoName);
		await app.pickRecent(fast.name);
		await screen.findByRole("tab", { name: fast.name, selected: true });
		opening.release(null);
		await app.settle();

		expect(app.host.preferences.get("recent_repos")).toEqual([fast, slow]);
		expect(
			screen.queryByRole("tab", { name: slow.name, selected: false }),
		).toBeInTheDocument();
	});

	it("reports a recent-list write failure while keeping the repository open", async () => {
		await start();
		const write = app.host.holdNextReply(
			"prefs_set",
			({ key }) => key === "recent_repos",
		);

		await app.pickRecent(fast.name);
		await write.entered;
		write.reject({ code: "io_error", message: "the disk is full" });
		await app.settle();

		expect(
			screen.getByRole("tab", { name: fast.name, selected: true }),
		).toBeInTheDocument();
		expect(toasts.items).toContainEqual(
			expect.objectContaining({
				message:
					"Opened fast, but could not save it in Recent: the disk is full",
				kind: "error",
			}),
		);
	});

	it("keeps a reopened picker visible and silent when the superseded open fails", async () => {
		await start();
		const opening = app.host.holdNextReply("open_repo");

		await app.pickRecent(slow.name);
		expect(await opening.entered).toEqual({ path: slow.path });
		await app.pickRecent(fast.name);
		await screen.findByRole("tab", { name: fast.name, selected: true });
		await app.settle();
		await showPicker();
		opening.reject({ code: "not_a_git_repo", message: "the drive is gone" });
		await app.settle();

		expect(picker()).toBeInTheDocument();
		expect(toasts.items).toEqual([]);
	});
});
