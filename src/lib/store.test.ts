import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedTab, TabInfo } from "./tab-types.js";
import { createTabId } from "./tab-types.js";

// The backing store for the mock — shared across all LazyStore instances
const backingStore = new Map<string, unknown>();

vi.mock("@tauri-apps/plugin-store", () => {
	class MockLazyStore {
		get(key: string) {
			return Promise.resolve(backingStore.get(key) ?? null);
		}
		set(key: string, value: unknown) {
			backingStore.set(key, value);
			return Promise.resolve();
		}
		save() {
			return Promise.resolve();
		}
	}
	return { LazyStore: MockLazyStore };
});

// Import store functions after mocking so module-level `new LazyStore(...)` gets the mock
const {
	addRecentRepo,
	getRecentRepos,
	removeRecentRepo,
	getZoomLevel,
	setZoomLevel,
	getDiffContextLines,
	setDiffContextLines,
	getDiffIgnoreWhitespace,
	setDiffIgnoreWhitespace,
	getDiffShowFullFile,
	setDiffShowFullFile,
	getDiffContentMode,
	setDiffContentMode,
	getDiffLayoutMode,
	setDiffLayoutMode,
	getCommitDraft,
	setCommitDraft,
	clearCommitDraft,
	getColumnWidths,
	getColumnVisibility,
	setColumnWidths,
	setColumnVisibility,
} = await import("./store.js");

describe("tab types and helpers", () => {
	it("createTabId returns UUID v4 format", () => {
		const id = createTabId();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});

	it("createTabId returns unique values", () => {
		const ids = new Set(Array.from({ length: 100 }, () => createTabId()));
		expect(ids.size).toBe(100);
	});

	it("TabInfo accepts valid object", () => {
		const tab: TabInfo = {
			id: "abc",
			repoPath: null,
			repoName: "New Tab",
			dirty: false,
		};
		expect(tab.id).toBe("abc");
		expect(tab.repoPath).toBeNull();
		expect(tab.repoName).toBe("New Tab");
		expect(tab.dirty).toBe(false);
	});

	it("PersistedTab is a subset of TabInfo", () => {
		const tab: TabInfo = {
			id: "123",
			repoPath: "/path/to/repo",
			repoName: "repo",
			dirty: true,
		};
		const persisted: PersistedTab = {
			id: tab.id,
			repoPath: tab.repoPath,
			repoName: tab.repoName,
		};
		expect(persisted.id).toBe(tab.id);
		expect(persisted.repoPath).toBe(tab.repoPath);
		expect(persisted.repoName).toBe(tab.repoName);
		// PersistedTab should not have 'dirty' — compile-time check, but runtime verify absence
		expect("dirty" in persisted).toBe(false);
	});
});

describe("store", () => {
	beforeEach(() => {
		backingStore.clear();
	});

	describe("recent repos", () => {
		it("getRecentRepos returns empty array when store is empty", async () => {
			const repos = await getRecentRepos();
			expect(repos).toEqual([]);
		});

		it("addRecentRepo adds a repo and getRecentRepos returns it", async () => {
			await addRecentRepo({ name: "myrepo", path: "/path/to/repo" });
			const repos = await getRecentRepos();
			expect(repos).toEqual([{ name: "myrepo", path: "/path/to/repo" }]);
		});

		it("addRecentRepo moves duplicate repo to front", async () => {
			await addRecentRepo({ name: "A", path: "/a" });
			await addRecentRepo({ name: "B", path: "/b" });
			await addRecentRepo({ name: "A", path: "/a" });
			const repos = await getRecentRepos();
			expect(repos).toEqual([
				{ name: "A", path: "/a" },
				{ name: "B", path: "/b" },
			]);
		});

		it("addRecentRepo keeps every entry (no cap) so the picker can list full history", async () => {
			for (let i = 0; i < 25; i++) {
				await addRecentRepo({ name: `repo${i}`, path: `/path/${i}` });
			}
			const repos = await getRecentRepos();
			expect(repos).toHaveLength(25);
			// Most recently added is at the front, very first add is still at the back.
			expect(repos[0]).toEqual({ name: "repo24", path: "/path/24" });
			expect(repos[repos.length - 1]).toEqual({
				name: "repo0",
				path: "/path/0",
			});
		});

		it("removeRecentRepo removes matching path", async () => {
			await addRecentRepo({ name: "A", path: "/a" });
			await addRecentRepo({ name: "B", path: "/b" });
			await removeRecentRepo("/a");
			const repos = await getRecentRepos();
			expect(repos).toEqual([{ name: "B", path: "/b" }]);
		});
	});

	describe("zoom level", () => {
		it("getZoomLevel returns 1 when store is empty (default)", async () => {
			const level = await getZoomLevel();
			expect(level).toBe(1);
		});

		it("setZoomLevel persists and getZoomLevel retrieves it", async () => {
			await setZoomLevel(1.5);
			const level = await getZoomLevel();
			expect(level).toBe(1.5);
		});
	});

	describe("diff preferences", () => {
		it("getDiffContextLines returns 3 when store is empty (default)", async () => {
			const lines = await getDiffContextLines();
			expect(lines).toBe(3);
		});

		it("setDiffContextLines persists and getDiffContextLines retrieves it", async () => {
			await setDiffContextLines(5);
			const lines = await getDiffContextLines();
			expect(lines).toBe(5);
		});

		it("getDiffIgnoreWhitespace returns false when store is empty (default)", async () => {
			const ignore = await getDiffIgnoreWhitespace();
			expect(ignore).toBe(false);
		});

		it("setDiffIgnoreWhitespace persists and getDiffIgnoreWhitespace retrieves it", async () => {
			await setDiffIgnoreWhitespace(true);
			const ignore = await getDiffIgnoreWhitespace();
			expect(ignore).toBe(true);
		});

		it("getDiffShowFullFile returns false when store is empty (default)", async () => {
			const show = await getDiffShowFullFile();
			expect(show).toBe(false);
		});

		it("setDiffShowFullFile persists and getDiffShowFullFile retrieves it", async () => {
			await setDiffShowFullFile(true);
			const show = await getDiffShowFullFile();
			expect(show).toBe(true);
		});
	});

	describe("diff content/layout mode", () => {
		it("getDiffContentMode returns 'hunk' when store is empty (default)", async () => {
			const mode = await getDiffContentMode();
			expect(mode).toBe("hunk");
		});

		it("setDiffContentMode persists and getDiffContentMode retrieves it", async () => {
			await setDiffContentMode("full");
			const mode = await getDiffContentMode();
			expect(mode).toBe("full");
		});

		it("getDiffLayoutMode returns 'inline' when store is empty (default)", async () => {
			const mode = await getDiffLayoutMode();
			expect(mode).toBe("inline");
		});

		it("setDiffLayoutMode persists and getDiffLayoutMode retrieves it", async () => {
			await setDiffLayoutMode("split");
			const mode = await getDiffLayoutMode();
			expect(mode).toBe("split");
		});

		it("getDiffContentMode migrates from legacy 'full' ViewMode key", async () => {
			backingStore.set("diff_view_mode", "full");
			const mode = await getDiffContentMode();
			expect(mode).toBe("full");
		});

		it("getDiffLayoutMode migrates from legacy 'split' ViewMode key", async () => {
			backingStore.set("diff_view_mode", "split");
			const mode = await getDiffLayoutMode();
			expect(mode).toBe("split");
		});

		it("new keys take priority over legacy key", async () => {
			backingStore.set("diff_view_mode", "split");
			backingStore.set("diff_content_mode", "full");
			backingStore.set("diff_layout_mode", "inline");
			expect(await getDiffContentMode()).toBe("full");
			expect(await getDiffLayoutMode()).toBe("inline");
		});
	});

	describe("commit drafts", () => {
		it("getCommitDraft returns null for an unknown path", async () => {
			const draft = await getCommitDraft("/unknown");
			expect(draft).toBeNull();
		});

		it("setCommitDraft persists and getCommitDraft round-trips it", async () => {
			await setCommitDraft("/repo", { subject: "summary", body: "details" });
			const draft = await getCommitDraft("/repo");
			expect(draft).toEqual({ subject: "summary", body: "details" });
		});

		it("setCommitDraft keeps drafts for other paths", async () => {
			await setCommitDraft("/a", { subject: "a-sub", body: "a-body" });
			await setCommitDraft("/b", { subject: "b-sub", body: "b-body" });
			expect(await getCommitDraft("/a")).toEqual({
				subject: "a-sub",
				body: "a-body",
			});
			expect(await getCommitDraft("/b")).toEqual({
				subject: "b-sub",
				body: "b-body",
			});
		});

		it("clearCommitDraft removes the entry", async () => {
			await setCommitDraft("/repo", { subject: "summary", body: "details" });
			await clearCommitDraft("/repo");
			expect(await getCommitDraft("/repo")).toBeNull();
		});

		it("clearCommitDraft leaves other entries intact", async () => {
			await setCommitDraft("/a", { subject: "a-sub", body: "a-body" });
			await setCommitDraft("/b", { subject: "b-sub", body: "b-body" });
			await clearCommitDraft("/a");
			expect(await getCommitDraft("/a")).toBeNull();
			expect(await getCommitDraft("/b")).toEqual({
				subject: "b-sub",
				body: "b-body",
			});
		});

		it("clearCommitDraft is a no-op for an unknown path", async () => {
			await clearCommitDraft("/nope");
			expect(await getCommitDraft("/nope")).toBeNull();
		});
	});

	describe("column widths and visibility migration", () => {
		it("getColumnWidths fills a default for a key missing from a legacy persisted object", async () => {
			// A user who persisted widths before the Diff column existed.
			backingStore.set("column_widths", {
				ref: 200,
				graph: 24,
				author: 60,
				date: 40,
				sha: 50,
			});

			const widths = await getColumnWidths();

			expect(widths.diff).toBe(96); // new key gets its default…
			expect(widths.ref).toBe(200); // …without clobbering persisted values
		});

		it("getColumnVisibility fills a default for a key missing from a legacy persisted object", async () => {
			backingStore.set("column_visibility", {
				ref: true,
				graph: true,
				message: true,
				author: false,
				date: true,
				sha: true,
			});

			const visibility = await getColumnVisibility();

			expect(visibility.diff).toBe(true); // new key defaults visible…
			expect(visibility.author).toBe(false); // …without clobbering persisted values
		});

		it("getColumnWidths returns all defaults when nothing is persisted", async () => {
			const widths = await getColumnWidths();
			expect(widths.diff).toBe(96);
			expect(widths.ref).toBe(120);
		});

		it("round-trips persisted widths including the diff key", async () => {
			await setColumnWidths({
				ref: 120,
				graph: 24,
				diff: 150,
				author: 60,
				date: 40,
				sha: 50,
			});
			expect((await getColumnWidths()).diff).toBe(150);
		});

		it("round-trips persisted visibility including the diff key", async () => {
			await setColumnVisibility({
				ref: true,
				graph: true,
				message: true,
				diff: false,
				author: true,
				date: true,
				sha: true,
			});
			expect((await getColumnVisibility()).diff).toBe(false);
		});
	});
});
