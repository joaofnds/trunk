import { setImmediate } from "node:timers/promises";
import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../tests/app/harness/dom.js";
import { makeCommit, makeFile } from "../__tests__/helpers/factories.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { SCHEDULER } from "../lib/scheduler.js";
import { _resetToasts } from "../lib/toast.svelte.js";
import RepoView from "./RepoView.svelte";

class PreferencesHost extends RepositoryReadHost {
	private readonly releases = new Set<() => void>();
	private heldPreference?: {
		command: "prefs_get" | "prefs_set";
		key: string;
		pause(): Promise<void>;
	};

	holdPreference(command: "prefs_get" | "prefs_set", key: string) {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const release = () => {
			this.releases.delete(release);
			released.resolve();
		};
		this.releases.add(release);
		this.heldPreference = {
			command,
			key,
			pause: () => {
				entered.resolve();
				return released.promise;
			},
		};
		return {
			entered: entered.promise,
			release,
			reject: (error: { code: string; message: string }) => {
				this.releases.delete(release);
				released.reject(error);
			},
		};
	}

	releaseHeldPreferences(): void {
		this.heldPreference = undefined;
		for (const release of this.releases) release();
	}

	override async invoke<T>(
		command: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		const held = this.heldPreference;
		if (
			held?.command === command &&
			held.key === (args as { key?: string }).key
		) {
			this.heldPreference = undefined;
			await held.pause();
		}
		return super.invoke<T>(command, args, onReply);
	}
}

let host: PreferencesHost;
const readError = { code: "io", message: "Could not read preferences" };

beforeEach(() => {
	host = new PreferencesHost();
	host.install();
	installDomPolyfills({ viewportHeight: 200 });
	host.seedGraph({
		commits: [makeCommit({ oid: "head", summary: "repository commit" })],
		max_columns: 1,
		checked: true,
		revision: 1,
	});
});

afterEach(async () => {
	cleanup();
	host.releaseHeldPreferences();
	await drainReplies();
	_resetToasts();
	host.dispose();
	restoreDomPolyfills();
});

describe("RepoView global preferences", () => {
	it("keeps both column changes when made in different mounted tabs", async () => {
		const first = mountRepository("/first", true);
		const second = mountRepository("/second", false);
		await drainReplies();
		const write = host.holdPreference("prefs_set", "column_visibility");

		await chooseColumn(first.container, "Diff");
		await write.entered;
		await first.rerender({ tabActive: false });
		await second.rerender({ tabActive: true });
		await chooseColumn(second.container, "Author");
		await drainReplies();
		const columnsWhileSaving = headerColumns(second.container);
		const savedWhileWriting = host.preferences.get("column_visibility");
		write.release();
		await drainReplies();

		expect(columnsWhileSaving).toEqual([
			"ref",
			"graph",
			"message",
			"date",
			"sha",
		]);
		expect(headerColumns(first.container)).toEqual(columnsWhileSaving);
		expect(savedWhileWriting).toBeUndefined();
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
			author: false,
		});
	});

	it("shows the chosen tree mode when returning to another mounted tab", async () => {
		const nestedFile = makeFile("src/lib/changes.ts");
		host.seedResponse("get_status", {
			unstaged: [nestedFile, makeFile("src/lib/types.ts")],
			staged: [],
			conflicted: [],
		});
		const first = mountRepository("/first", true);
		const second = mountRepository("/second", false);
		const firstPane = within(first.container);
		const secondPane = within(second.container);
		const listMode = { name: "Switch to tree view" };
		const treeMode = { name: "Switch to list view" };
		const firstToggle = await firstPane.findByRole("switch", listMode);
		await secondPane.findByRole("switch", listMode);
		const firstChanges = within(
			await firstPane.findByTestId("staging-unstaged-section"),
		);
		expect(await firstChanges.findByTitle(nestedFile.path)).toBeVisible();

		await fireEvent.click(firstToggle);
		await first.rerender({ tabActive: false });
		await second.rerender({ tabActive: true });
		const secondChanges = within(
			await secondPane.findByTestId("staging-unstaged-section"),
		);
		const tree = within(await secondChanges.findByRole("tree"));
		const directory = tree.getByRole("treeitem", { name: /src\/lib/ });
		await fireEvent.click(directory);

		expect(secondPane.getByRole("switch", treeMode)).toBeVisible();
		expect(directory).toHaveAttribute("aria-expanded", "true");
		expect(tree.getByRole("treeitem", { name: /changes\.ts/ })).toHaveAttribute(
			"aria-level",
			"2",
		);
		expect(host.preferences.get("tree_view_enabled")).toBe(true);
	});

	it("keeps a column change made while the saved columns are loading", async () => {
		host.preferences.set("column_visibility", { diff: false, message: false });
		const read = host.holdPreference("prefs_get", "column_visibility");
		const view = mountRepository("/repo", true);
		await read.entered;
		await within(view.container).findByText("repository commit");

		await chooseColumn(view.container, "Author");
		read.release();
		await drainReplies();

		expect(headerColumns(view.container)).toEqual([
			"ref",
			"graph",
			"message",
			"date",
			"sha",
		]);
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
			author: false,
			message: true,
		});
		expect(host.count("get_commit_stats")).toBe(0);
		expect(host.count("get_wip_diff_stats")).toBe(0);
	});

	it("preserves saved Diff visibility across a failed read and an Author change", async () => {
		host.preferences.set("column_visibility", { diff: false });
		const read = host.holdPreference("prefs_get", "column_visibility");
		const view = mountRepository("/repo", true);
		await read.entered;
		await within(view.container).findByText("repository commit");
		read.reject(readError);
		await drainReplies();
		const retry = host.holdPreference("prefs_get", "column_visibility");

		await chooseColumn(view.container, "Author");
		await drainReplies();
		const columnsWhileReading = headerColumns(view.container);
		const savedWhileReading = host.preferences.get("column_visibility");
		retry.release();
		await drainReplies();

		expect(savedWhileReading).toEqual({ diff: false });
		expect(columnsWhileReading).not.toContain("author");
		expect(headerColumns(view.container)).toEqual([
			"ref",
			"graph",
			"message",
			"date",
			"sha",
		]);
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
			author: false,
		});
	});

	it("replays an unsaved column change when the next mount restores preferences", async () => {
		host.preferences.set("column_visibility", { diff: false });
		const read = host.holdPreference("prefs_get", "column_visibility");
		const view = mountRepository("/first", true);
		await read.entered;
		await within(view.container).findByText("repository commit");

		await chooseColumn(view.container, "Author");
		read.reject(readError);
		await drainReplies();
		const savedAfterFailure = host.preferences.get("column_visibility");
		view.unmount();
		const reopened = mountRepository("/second", true);
		await within(reopened.container).findByText("repository commit");
		await drainReplies();

		expect(savedAfterFailure).toEqual({ diff: false });
		expect(headerColumns(reopened.container)).toEqual([
			"ref",
			"graph",
			"message",
			"date",
			"sha",
		]);
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
			author: false,
		});
	});

	it("saves both column changes when a later write recovers", async () => {
		const view = mountRepository("/repo", true);
		await within(view.container).findByText("repository commit");
		await drainReplies();
		const write = host.holdPreference("prefs_set", "column_visibility");

		await chooseColumn(view.container, "Diff");
		await write.entered;
		write.reject({ code: "io", message: "Could not write preferences" });
		await drainReplies();
		const savedAfterFailure = host.preferences.get("column_visibility");
		await chooseColumn(view.container, "Author");
		await drainReplies();

		expect(savedAfterFailure).toBeUndefined();
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
			author: false,
		});
	});

	it("uses the column state the open menu showed when the saved columns arrive", async () => {
		host.preferences.set("column_visibility", { diff: false });
		const read = host.holdPreference("prefs_get", "column_visibility");
		const view = mountRepository("/repo", true);
		await read.entered;
		await within(view.container).findByText("repository commit");
		await openColumnMenu(view.container);
		expect(host.contextMenu.checked("Diff")).toBe(true);

		read.release();
		await drainReplies();
		host.contextMenu.choose("Diff");
		await openColumnMenu(view.container);

		expect(headerColumns(view.container)).not.toContain("diff");
		expect(host.contextMenu.checked("Diff")).toBe(false);
		expect(host.preferences.get("column_visibility")).toMatchObject({
			diff: false,
		});
	});
});

function mountRepository(repoPath: string, tabActive: boolean) {
	return render(RepoView, {
		props: {
			repoPath,
			tabActive,
			remoteState: createRemoteState(),
			diffPreferences: DiffPreferences.defaults(),
			leftPaneWidth: 200,
			leftPaneCollapsed: false,
			rightPaneWidth: 300,
			rightPaneCollapsed: false,
			windowFocused: false,
			reviewActive: false,
			contentMode: "hunk",
			oncontentmodechange: () => {},
			onreviewpanelshowingchange: () => {},
			onleftpanecollapsedchange: () => {},
			onrightpanecollapsedchange: () => {},
			onleftpanewidthchange: () => {},
			onrightpanewidthchange: () => {},
			onleavereview: () => {},
		},
		context: new Map([[SCHEDULER, new FakeScheduler()]]),
	});
}

function header(container: HTMLElement): HTMLElement {
	return within(container).getByTestId("column-header");
}

function headerColumns(container: HTMLElement) {
	return Array.from(
		header(container).querySelectorAll("[data-column]"),
		(cell) => cell.getAttribute("data-column"),
	);
}

async function chooseColumn(
	container: HTMLElement,
	label: string,
): Promise<void> {
	await openColumnMenu(container);
	host.contextMenu.choose(label);
}

async function openColumnMenu(container: HTMLElement): Promise<void> {
	await fireEvent.contextMenu(header(container));
	await drainReplies();
}

async function drainReplies(): Promise<void> {
	await setImmediate();
	await tick();
}
