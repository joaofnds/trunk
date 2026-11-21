import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedTab } from "../../src/lib/tab-types.js";
import { remount, setup, teardown } from "./harness/index.js";

async function restoreSavedTabs(...names: string[]) {
	const app = await setup();
	await app.settled();
	await app.seedPref(
		"open_tabs",
		names.map((repoName) => ({
			id: repoName.toLowerCase(),
			repoPath: null,
			repoName,
		})),
	);
	await app.seedPref("active_tab_id", names[0].toLowerCase());
	await remount();
	await app.settled();
	return app;
}

function selectedTab(): string | undefined {
	return screen.getByRole("tab", { selected: true }).textContent?.trim();
}

describe("tab restoration", () => {
	afterEach(teardown);

	it.each([
		{ shortcut: "Cmd+2", key: { key: "2", metaKey: true }, name: "Second" },
		{
			shortcut: "Ctrl+Tab",
			key: { key: "Tab", ctrlKey: true },
			name: "Second",
		},
		{
			shortcut: "Ctrl+Shift+Tab",
			key: { key: "Tab", ctrlKey: true, shiftKey: true },
			name: "Third",
		},
	])("restores the tab chosen with $shortcut", async ({ key, name }) => {
		const app = await restoreSavedTabs("First", "Second", "Third");

		await fireEvent.keyDown(window, key);
		expect(selectedTab()).toBe(name);
		await app.settled();
		await remount();
		await app.settled();

		expect(selectedTab()).toBe(name);
	});

	it("waits for a dispatched tab save when remounting", async () => {
		const app = await restoreSavedTabs("First", "Second");
		const opensBefore = app
			.invokes()
			.filter(({ cmd }) => cmd === "prefs_open_tabs").length;
		const entered = Promise.withResolvers<void>();
		const release = app.holdCommand(({ cmd }) => {
			if (cmd !== "prefs_set_tabs") return false;
			entered.resolve();
			return true;
		});
		await fireEvent.mouseDown(screen.getByRole("tab", { name: "Second" }), {
			button: 0,
		});
		await entered.promise;

		await remount();
		await tick();
		const opensWhileSaving = app
			.invokes()
			.filter(({ cmd }) => cmd === "prefs_open_tabs").length;
		release();
		await app.settled();

		expect(opensWhileSaving).toBe(opensBefore);
		expect(selectedTab()).toBe("Second");
	});

	it.each(["first", "last"] as const)(
		"keeps the live writer when a disposed mount's restore reaches native %s",
		async (disposedOrder) => {
			const app = await restoreSavedTabs("First", "Second");
			const first = Promise.withResolvers<void>();
			const second = Promise.withResolvers<void>();
			let openCount = 0;
			const release = app.holdCommand(({ cmd }) => {
				if (cmd !== "prefs_open_tabs") return false;
				openCount += 1;
				if (openCount === 1) {
					first.resolve();
					return true;
				}
				second.resolve();
				return disposedOrder === "first";
			});
			await remount();
			await first.promise;
			await remount();
			await second.promise;
			if (disposedOrder === "last")
				await screen.findByRole("tab", { name: "First", selected: true });
			release();
			await app.settled();

			await fireEvent.mouseDown(screen.getByRole("tab", { name: "Second" }), {
				button: 0,
			});
			await app.settled();
			await remount();
			await app.settled();

			expect(selectedTab()).toBe("Second");
		},
	);

	it("keeps a tab closed when its earlier selection reaches the disk last", async () => {
		const stay = { id: "stay", repoPath: null, repoName: "Stay" };
		const discard = { id: "discard", repoPath: null, repoName: "Discard" };
		const app = await restoreSavedTabs(stay.repoName, discard.repoName);
		const entered = Promise.withResolvers<void>();
		const stale = app.holdCommand(({ cmd, args }) => {
			if (cmd !== "prefs_set_tabs" || args.activeTabId !== discard.id)
				return false;
			entered.resolve();
			return true;
		});
		const tab = screen.getByRole("tab", { name: "Discard" });
		const item = tab.parentElement;
		if (!item) throw new Error("the tab has no container");
		const close = within(item).getByRole("button", {
			name: "Close tab",
		});

		await fireEvent.mouseDown(tab, { button: 0 });
		await entered.promise;
		await fireEvent.click(close);
		const savedTabs = async () => ({
			tabs: await app.readPref<PersistedTab[]>("open_tabs"),
			active: await app.readPref<string>("active_tab_id"),
		});
		await waitFor(async () => {
			expect(await savedTabs()).toEqual({ tabs: [stay], active: stay.id });
		});
		stale();
		await app.settled();
		await remount();
		await app.settled();

		expect({
			...(await savedTabs()),
			open: screen.getAllByRole("tab").map((tab) => tab.textContent?.trim()),
			selected: screen.getByRole("tab", { selected: true }).textContent?.trim(),
		}).toEqual({
			tabs: [stay],
			active: stay.id,
			open: ["Stay"],
			selected: "Stay",
		});
	});
});
