import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToRepoChanges } from "./repo-change-subscription.js";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockListen = vi.mocked(listen);

beforeEach(() => mockListen.mockReset());

describe("subscribeToRepoChanges", () => {
	it("invalidates only for the captured repository", async () => {
		let handler: ((event: { payload: unknown }) => void) | undefined;
		mockListen.mockImplementation(async (_name, callback) => {
			handler = callback as (event: { payload: unknown }) => void;
			return () => {};
		});
		let invalidations = 0;
		const refresh = {
			invalidate: () => {
				invalidations++;
			},
		};
		const dispose = subscribeToRepoChanges("/repo", refresh);
		await Promise.resolve();

		handler?.({ payload: { repo: "/elsewhere", paths: [] } });
		handler?.({ payload: { repo: "/repo", paths: [] } });

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

// The payload names the files a change touched, and a subscriber that depends on
// particular files reads them to skip a write concerning none of them
// (TRUNK-232).
describe("subscribeToRepoChanges payload", () => {
	it("hands the changed paths to the subscriber", async () => {
		let handler: ((event: { payload: unknown }) => void) | undefined;
		mockListen.mockImplementation(async (_name, callback) => {
			handler = callback as (event: { payload: unknown }) => void;
			return () => {};
		});
		const seen: Array<readonly string[]> = [];
		const dispose = subscribeToRepoChanges("/repo", {
			invalidate: (changed) => seen.push(changed),
		});
		await Promise.resolve();

		handler?.({ payload: { repo: "/repo", paths: ["src/a.ts", "src/b.ts"] } });

		expect(seen).toEqual([["src/a.ts", "src/b.ts"]]);
		dispose();
	});
});
