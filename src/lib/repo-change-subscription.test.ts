import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToRepoChanges } from "./repo-change-subscription.js";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockListen = vi.mocked(listen);

beforeEach(() => mockListen.mockReset());

describe("subscribeToRepoChanges", () => {
	it("invalidates only for the captured repository", async () => {
		let handler: ((event: { payload: string }) => void) | undefined;
		mockListen.mockImplementation(async (_name, callback) => {
			handler = callback as (event: { payload: string }) => void;
			return () => {};
		});
		let invalidations = 0;
		const refresh = { invalidate: () => invalidations++ };
		const dispose = subscribeToRepoChanges("/repo", refresh);
		await Promise.resolve();

		handler?.({ payload: "/elsewhere" });
		handler?.({ payload: "/repo" });

		expect(invalidations).toBe(1);
		dispose();
	});

	it("unlistens when registration finishes after disposal", async () => {
		let finishRegistration!: (unlisten: () => void) => void;
		mockListen.mockReturnValue(
			new Promise((resolve) => {
				finishRegistration = resolve;
			}),
		);
		let unlistened = false;
		const unlisten = () => {
			unlistened = true;
		};
		const dispose = subscribeToRepoChanges("/repo", {
			invalidate: () => {},
		});

		dispose();
		finishRegistration(unlisten);
		await Promise.resolve();

		expect(unlistened).toBe(true);
	});
});
