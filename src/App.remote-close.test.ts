import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../tests/app/harness/dom.js";
import { makeCommit } from "./__tests__/helpers/factories.js";
import { RepositoryReadHost } from "./__tests__/helpers/repository-read-host.js";
import App from "./App.svelte";
import { SCHEDULER } from "./lib/scheduler.js";
import { _resetToasts, toasts } from "./lib/toast.svelte.js";

let host: RepositoryReadHost;

beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
	installDomPolyfills();
	host.preferences.set("open_tabs", [
		{ id: "tab-1", repoPath: "/repo", repoName: "repo" },
	]);
	host.preferences.set("active_tab_id", "tab-1");
	host.preferences.set("fetch_interval_ms", 0);
	host.preferences.set("recent_repos", [{ path: "/repo", name: "repo" }]);
	host.seedGraph({
		commits: [makeCommit({ oid: "head-oid", summary: "head commit" })],
		max_columns: 1,
		checked: true,
		revision: 1,
	});
	_resetToasts();
});

afterEach(() => {
	cleanup();
	host.dispose();
	restoreDomPolyfills();
	_resetToasts();
});

async function openApp(): Promise<void> {
	render(App, { context: new Map([[SCHEDULER, new FakeScheduler()]]) });
	await screen.findAllByText("head commit");
}

async function startThenCloseTab(command: string, button: string) {
	const operation = host.holdNextReply(command);
	await fireEvent.click(screen.getByRole("button", { name: button }));
	await operation.entered;
	await fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
	await waitFor(() => expect(host.count("close_repo")).toBe(1));
	return operation;
}

function pushThenCloseTab() {
	return startThenCloseTab("git_push", "Push");
}

async function reopenRepository(): Promise<void> {
	await fireEvent.keyDown(window, { key: "r", ctrlKey: true });
	const recents = await screen.findByRole("listbox", {
		name: "Recent repositories",
	});
	await fireEvent.click(within(recents).getByText("repo"));
	await screen.findAllByText("head commit");
}

describe("a push whose tab closes before it ends", () => {
	it("reports its failure, since no tab shows it", async () => {
		await openApp();
		const push = await pushThenCloseTab();

		push.reject({ code: "remote_error", message: "pre-push hook refused" });

		await waitFor(() =>
			expect(toasts.items.map((toast) => toast.message)).toEqual([
				"The push from repo failed after its tab closed. pre-push hook refused",
			]),
		);
	});

	it("shows as running in a tab that opens its repository again", async () => {
		await openApp();
		await pushThenCloseTab();

		await reopenRepository();

		expect(screen.getByRole("button", { name: "Push" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
	});

	it("reports its failure in the tab that opened its repository again", async () => {
		await openApp();
		const push = await pushThenCloseTab();
		await reopenRepository();

		push.reject({ code: "remote_error", message: "pre-push hook refused" });

		await screen.findByText("pre-push hook refused");
		expect(toasts.items).toEqual([]);
	});
});

describe("a pull whose tab closes before it lands", () => {
	it("names its repository when it lands, since no tab shows it", async () => {
		await openApp();
		const pull = await startThenCloseTab("git_pull", "Pull");

		pull.release(null);

		await waitFor(() =>
			expect(toasts.items.map((toast) => toast.message)).toEqual([
				"The pull from repo finished after its tab closed.",
			]),
		);
	});
});
