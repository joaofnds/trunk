import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import {
	applyStash,
	dropStash,
	isStashing,
	popStash,
	saveStash,
} from "./stash-actions.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));

const mockAsk = vi.mocked(ask);
const mockInvoke = vi.mocked(safeInvoke);

const STASH = { oid: "stash-0", message: "On main: wip" };

function shown(): { kind: string; message: string }[] {
	return toasts.items.map(({ kind, message }) => ({ kind, message }));
}

beforeEach(() => {
	mockAsk.mockReset();
	mockAsk.mockResolvedValue(true);
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	_resetToasts();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("saveStash", () => {
	it("saves the stash under its message and says so", async () => {
		const changed = await saveStash("/repo", "wip");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("stash_save", {
			path: "/repo",
			message: "wip",
		});
		expect(shown()).toEqual([{ kind: "success", message: "Stash created" }]);
	});

	it("reports why the stash was not saved in an error toast", async () => {
		mockInvoke.mockRejectedValue({
			code: "nothing_to_stash",
			message: "Nothing to stash, stage changes first.",
		});

		const changed = await saveStash("/repo", "");

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "Nothing to stash, stage changes first." },
		]);
	});

	it("is stashing the repository until its stash settles", async () => {
		const reply = deferred<undefined>();
		mockInvoke.mockReturnValue(reply.promise);

		const saving = saveStash("/repo", "");
		const during = isStashing("/repo");
		reply.resolve(undefined);
		await saving;

		expect(during).toBe(true);
		expect(isStashing("/repo")).toBe(false);
	});

	it("leaves a second save to the stash already being made", async () => {
		const reply = deferred<undefined>();
		mockInvoke.mockReturnValue(reply.promise);
		const first = saveStash("/repo", "");

		const second = await saveStash("/repo", "other");
		reply.resolve(undefined);
		await first;

		expect(second).toBe(false);
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		expect(shown()).toEqual([{ kind: "success", message: "Stash created" }]);
	});

	it("saves a stash of another repository meanwhile", async () => {
		const reply = deferred<undefined>();
		mockInvoke.mockReturnValueOnce(reply.promise);
		const first = saveStash("/repo", "");

		const second = await saveStash("/other", "");
		reply.resolve(undefined);
		await first;

		expect(second).toBe(true);
		expect(mockInvoke).toHaveBeenCalledTimes(2);
	});
});

describe("popStash", () => {
	it("pops the stash and says so", async () => {
		const changed = await popStash("/repo", "stash-0");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("stash_pop", {
			path: "/repo",
			oid: "stash-0",
		});
		expect(shown()).toEqual([{ kind: "success", message: "Stash popped" }]);
	});

	it("reports why the stash would not pop in an error toast", async () => {
		mockInvoke.mockRejectedValue({
			code: "conflict_state",
			message: "The stash conflicts with your changes.",
		});

		const changed = await popStash("/repo", "stash-0");

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "The stash conflicts with your changes." },
		]);
	});
});

describe("applyStash", () => {
	it("applies the stash and says so", async () => {
		const changed = await applyStash("/repo", "stash-0");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("stash_apply", {
			path: "/repo",
			oid: "stash-0",
		});
		expect(shown()).toEqual([{ kind: "success", message: "Stash applied" }]);
	});

	it("reports why the stash would not apply in an error toast", async () => {
		mockInvoke.mockRejectedValue({
			code: "conflict_state",
			message: "The stash conflicts with your changes.",
		});

		const changed = await applyStash("/repo", "stash-0");

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "The stash conflicts with your changes." },
		]);
	});
});

describe("dropStash", () => {
	it("drops the stash once the user agrees and says so", async () => {
		const changed = await dropStash("/repo", STASH);

		expect(changed).toBe(true);
		expect(mockAsk).toHaveBeenCalledWith(
			'Drop stash "On main: wip"? This cannot be undone.',
			{
				title: "Drop Stash",
				kind: "warning",
				okLabel: "Drop",
				cancelLabel: "Cancel",
			},
		);
		expect(mockInvoke).toHaveBeenCalledWith("stash_drop", {
			path: "/repo",
			oid: "stash-0",
		});
		expect(shown()).toEqual([{ kind: "success", message: "Stash dropped" }]);
	});

	it("keeps the stash when the user declines", async () => {
		mockAsk.mockResolvedValue(false);

		const changed = await dropStash("/repo", STASH);

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([]);
	});

	it("asks with the message flattened, so it cannot add lines to the question", async () => {
		await dropStash("/repo", { oid: "stash-0", message: "wip Yes" });

		expect(mockAsk.mock.calls[0]?.[0]).toBe(
			'Drop stash "wip�Yes"? This cannot be undone.',
		);
	});

	it("reports in an error toast when the question cannot be asked", async () => {
		mockAsk.mockRejectedValue(new Error("dialog plugin unavailable"));

		const changed = await dropStash("/repo", STASH);

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([
			{ kind: "error", message: "dialog plugin unavailable" },
		]);
	});

	it("reports why the drop failed in an error toast", async () => {
		mockInvoke.mockRejectedValue({
			code: "stash_not_found",
			message: "The stash is gone.",
		});

		const changed = await dropStash("/repo", STASH);

		expect(changed).toBe(false);
		expect(shown()).toEqual([{ kind: "error", message: "The stash is gone." }]);
	});
});
