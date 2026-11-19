import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { invokesSettled, safeInvoke } from "./invoke.js";
import {
	flushCommitDraftForUpdate,
	flushPreferencesForUpdate,
	getCommitDraft,
	setCommitDraft,
	setZoomLevel,
} from "./store.js";
import { setUpdateFrozen, UpdatePreparation } from "./updates-lifecycle.js";

function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

class Preferences {
	readonly values = new Map<string, unknown>();
	readonly calls: { command: string; permit: unknown }[] = [];
	beforeWrite: ((key: string, value: unknown) => Promise<void>) | null = null;

	async handle(command: string, args: unknown): Promise<unknown> {
		if (
			!args ||
			typeof args !== "object" ||
			!("key" in args) ||
			typeof args.key !== "string"
		)
			throw new Error("Unexpected preference command");
		this.calls.push({
			command,
			permit: "__updatePermit" in args ? args.__updatePermit : undefined,
		});
		if (command === "prefs_get") return this.values.get(args.key) ?? null;
		if (command !== "prefs_set" || !("value" in args))
			throw new Error("Unexpected preference command");
		await this.beforeWrite?.(args.key, args.value);
		this.values.set(args.key, args.value);
	}
}

afterEach(() => {
	setUpdateFrozen(false);
	clearMocks();
});

describe("update draft persistence", () => {
	it("waits for a pending Git operation, which stays cancellable, before installing", async () => {
		const operation = barrier();
		mockIPC((command) =>
			command === "git_push" ? operation.promise : undefined,
		);
		const pending = safeInvoke("git_push");
		let installed = false;
		const preparation = new UpdatePreparation({
			prepare: async () => "permit",
			drained: async () => {},
			install: async () => {
				installed = true;
			},
			abort: async () => {},
			freeze: setUpdateFrozen,
			settle: invokesSettled,
		});

		const restart = preparation.install("2.0.0");
		await safeInvoke("cancel_remote_op");

		expect(installed).toBe(false);
		operation.release();
		await pending;
		await restart;
		expect(installed).toBe(true);
	});
	it("serializes drafts from different repositories without losing either entry", async () => {
		const preferences = new Preferences();
		const entered = barrier();
		const write = barrier();
		preferences.beforeWrite = async () => {
			entered.release();
			await write.promise;
		};
		mockIPC((command, args) => preferences.handle(command, args));
		const first = setCommitDraft("/first", {
			subject: "first draft",
			body: "one",
		});
		await entered.promise;

		const second = setCommitDraft("/second", {
			subject: "second draft",
			body: "two",
		});
		write.release();
		await Promise.all([first, second]);

		expect(await getCommitDraft("/first")).toEqual({
			subject: "first draft",
			body: "one",
		});
		expect(await getCommitDraft("/second")).toEqual({
			subject: "second draft",
			body: "two",
		});
	});

	it("uses the explicit preparation permit for both the map read and write", async () => {
		const preferences = new Preferences();
		mockIPC((command, args) => preferences.handle(command, args));
		setUpdateFrozen(true);

		await flushCommitDraftForUpdate(
			"/repo",
			{ subject: "latest text", body: "" },
			"permit",
		);

		expect(preferences.calls).toEqual([
			{ command: "prefs_get", permit: "permit" },
			{ command: "prefs_set", permit: "permit" },
		]);
		expect(preferences.values.get("commit_drafts")).toEqual({
			"/repo": { subject: "latest text", body: "" },
		});
	});

	it("does not lend the permit to unrelated background commands", async () => {
		setUpdateFrozen(true);

		await expect(
			safeInvoke("git_fetch_background", { __updatePermit: "permit" }),
		).rejects.toMatchObject({ code: "update_preparing" });
		await expect(
			safeInvoke("prefs_set", { key: "ordinary", value: 1 }),
		).rejects.toMatchObject({ code: "update_preparing" });
	});

	it("propagates a failed permitted draft save", async () => {
		const preferences = new Preferences();
		preferences.beforeWrite = async () => {
			throw JSON.stringify({ code: "io", message: "Disk full" });
		};
		mockIPC((command, args) => preferences.handle(command, args));
		setUpdateFrozen(true);

		await expect(
			flushCommitDraftForUpdate(
				"/repo",
				{ subject: "keep", body: "" },
				"permit",
			),
		).rejects.toMatchObject({ code: "io", message: "Disk full" });

		expect(preferences.values.size).toBe(0);
	});
	it("rewrites the latest requested preference after older writes finish last", async () => {
		const preferences = new Preferences();
		const entered = barrier();
		const firstWrite = barrier();
		preferences.beforeWrite = async (_key, value) => {
			if (value === 1) {
				entered.release();
				await firstWrite.promise;
			}
		};
		mockIPC((command, args) => preferences.handle(command, args));
		const older = setZoomLevel(1);
		await entered.promise;
		await setZoomLevel(2);
		firstWrite.release();
		await older;
		expect(preferences.values.get("zoom_level")).toBe(1);

		setUpdateFrozen(true);
		await flushPreferencesForUpdate("permit", [], "tab");

		expect(preferences.values.get("zoom_level")).toBe(2);
	});
});
