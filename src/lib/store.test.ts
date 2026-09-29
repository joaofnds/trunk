import { beforeEach, describe, expect, it, vi } from "vitest";
import { columnFloors } from "./column-widths.js";
import {
	EVERYTHING_VISIBLE,
	toggleRef,
	toggleStash,
} from "./ref-visibility.js";
import type { PersistedTab, TabInfo } from "./tab-types.js";
import { createTabId } from "./tab-types.js";

// Map-backed fake of the prefs_get/prefs_set Tauri commands, dispatched by
// command name so an unrelated invoke can never satisfy a prefs call.
const backingStore = new Map<string, unknown>();

vi.mock("./invoke.js", () => ({
	safeInvoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "prefs_get") {
			return Promise.resolve(backingStore.get(args?.key as string) ?? null);
		}
		if (cmd === "prefs_set") {
			backingStore.set(args?.key as string, args?.value);
			return Promise.resolve(undefined);
		}
		return Promise.reject({
			code: "unmocked_command",
			message: `unmocked command: ${cmd}`,
		});
	}),
}));

const { safeInvoke } = await import("./invoke.js");

// Import store functions after mocking so store.ts binds the mocked safeInvoke
const {
	addRecentRepo,
	getRecentRepos,
	removeRecentRepo,
	getZoomLevel,
	setZoomLevel,
	getReviewFilter,
	setReviewFilter,
	getDiffContextLines,
	setDiffContextLines,
	getDiffIgnoreWhitespace,
	setDiffIgnoreWhitespace,
	getDiffContentMode,
	setDiffContentMode,
	getDiffLayoutMode,
	setDiffLayoutMode,
	getCommitDraft,
	setCommitDraft,
	clearCommitDraft,
	loadUserWidths,
	saveUserWidths,
	getColumnVisibility,
	setColumnVisibility,
	getRefVisibility,
	setRefVisibility,
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

// Holds the next pref write until the returned release is called, so a test
// can make a second call while the first is still in flight. Reads pass
// through, so a read that does not wait its turn sees the store as it was.
function holdNextPrefWrite(): () => void {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const invoke = vi.mocked(safeInvoke);
	const direct = invoke.getMockImplementation();
	let holding = true;
	invoke.mockImplementation(async (cmd, args) => {
		if (holding && cmd === "prefs_set") {
			holding = false;
			await held;
		}
		return direct?.(cmd, args);
	});

	return () => {
		if (direct) invoke.mockImplementation(direct);
		release();
	};
}

// Stored widths nothing can be laid out with.
const unusableWidths = [
	["null", null],
	["a string", "120"],
	["NaN", Number.NaN],
	["negative", -40],
	["zero", 0],
] as const;
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

	describe("review filter", () => {
		it("defaults to all when the preference is absent", async () => {
			expect(await getReviewFilter()).toBe("all");
		});

		it("persists a valid filter", async () => {
			await setReviewFilter("stale");
			expect(await getReviewFilter()).toBe("stale");
		});

		it("falls back to all for an invalid stored value", async () => {
			backingStore.set("review_filter", "legacy-toggle");
			expect(await getReviewFilter()).toBe("all");
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

	describe("user widths", () => {
		const floors = columnFloors((text) => text.length * 7);

		it("finds none in a repository where nothing is stored", async () => {
			expect(await loadUserWidths("/repo/a", floors)).toEqual({});
		});

		it("returns what the user set in that repository", async () => {
			await saveUserWidths("/repo/a", { ref: 180, author: 213 });

			expect(await loadUserWidths("/repo/a", floors)).toEqual({
				ref: 180,
				author: 213,
			});
		});

		it("keeps each repository's widths to that repository", async () => {
			await saveUserWidths("/repo/a", { ref: 180 });

			expect(await loadUserWidths("/repo/b", floors)).toEqual({});
		});

		// A user width has no ceiling, so a stored one must not come back
		// narrower than the user left it, however wide that was.
		it("returns a wide stored width as it was stored", async () => {
			await saveUserWidths("/repo/a", { graph: 900 });

			expect((await loadUserWidths("/repo/a", floors)).graph).toBe(900);
		});

		// Each pref write is its own IPC call and nothing on the Rust side orders
		// them, so a save made second must still be the one that lands.
		it("lands saves for one repository in the order they were made", async () => {
			const release = holdNextPrefWrite();

			const first = saveUserWidths("/repo/a", { author: 213 });
			const second = saveUserWidths("/repo/a", {});
			release();
			await Promise.all([first, second]);

			expect(await loadUserWidths("/repo/a", floors)).toEqual({});
		});

		it("keeps both of two saves for different repositories made together", async () => {
			const release = holdNextPrefWrite();

			const first = saveUserWidths("/repo/a", { author: 213 });
			const second = saveUserWidths("/repo/b", { ref: 180 });
			release();
			await Promise.all([first, second]);

			expect(await loadUserWidths("/repo/a", floors)).toEqual({ author: 213 });
			expect(await loadUserWidths("/repo/b", floors)).toEqual({ ref: 180 });
		});

		// A drag's save still in flight when the graph remounts, as it does when
		// a diff closes, must be what the remount reads.
		it("reads a save made before it once that save has landed", async () => {
			const release = holdNextPrefWrite();

			const saved = saveUserWidths("/repo/a", { author: 213 });
			const loaded = loadUserWidths("/repo/a", floors);
			release();
			await saved;

			expect(await loaded).toEqual({ author: 213 });
		});

		describe("when a stored entry is not a record of widths", () => {
			const notARecord = [
				["a number", 7],
				["a string", "wide"],
				["a list", [180]],
			] as const;

			it.each(notARecord)(
				"falls back to the widths from before they were per repository for %s",
				async (_name, value) => {
					backingStore.set("column_user_widths:/repo/a", value);
					backingStore.set("column_widths", { ref: 200 });
					backingStore.set("resized_columns", ["ref"]);

					expect(await loadUserWidths("/repo/a", floors)).toEqual({
						ref: 200,
					});
				},
			);
		});

		describe("when a stored width is not usable", () => {
			it.each(unusableWidths)(
				"leaves the column to its fit for %s",
				async (_name, value) => {
					backingStore.set("column_user_widths:/repo/a", {
						ref: 200,
						author: value,
					});

					expect(await loadUserWidths("/repo/a", floors)).toEqual({
						ref: 200,
					});
				},
			);
		});

		it("drops a stored name that is not a sized column", async () => {
			backingStore.set("column_user_widths:/repo/a", {
				ref: 200,
				message: 300,
				nonsense: 40,
			});

			expect(await loadUserWidths("/repo/a", floors)).toEqual({ ref: 200 });
		});

		it("rounds a stored width and holds it to the column's floor", async () => {
			backingStore.set("column_user_widths:/repo/a", {
				ref: 200.6,
				author: 1,
			});

			expect(await loadUserWidths("/repo/a", floors)).toEqual({
				ref: 201,
				author: floors.author,
			});
		});

		describe("stored for every repository before they were per repository", () => {
			it("opens a repository with none of its own at the columns the user resized", async () => {
				backingStore.set("column_widths", { ref: 200, graph: 56, author: 90 });
				backingStore.set("resized_columns", ["ref", "graph"]);

				expect(await loadUserWidths("/repo/a", floors)).toEqual({
					ref: 200,
					graph: 56,
				});
			});

			// The one way out of a user width is a double-click, so a repository
			// whose last one was handed back must not get the old widths again.
			it("is not read by a repository whose own widths were all handed back", async () => {
				backingStore.set("column_widths", { ref: 200 });
				backingStore.set("resized_columns", ["ref"]);
				await saveUserWidths("/repo/a", {});

				expect(await loadUserWidths("/repo/a", floors)).toEqual({});
			});

			it("gives a resized column missing from the stored widths its default", async () => {
				// A user who persisted widths before the Diff column existed.
				backingStore.set("column_widths", { ref: 200 });
				backingStore.set("resized_columns", ["ref", "diff"]);

				expect(await loadUserWidths("/repo/a", floors)).toEqual({
					ref: 200,
					diff: 96,
				});
			});

			it.each(unusableWidths)(
				"gives a resized column its default for %s",
				async (_name, value) => {
					backingStore.set("column_widths", { ref: 200, author: value });
					backingStore.set("resized_columns", ["ref", "author"]);

					expect(await loadUserWidths("/repo/a", floors)).toEqual({
						ref: 200,
						author: 60,
					});
				},
			);

			it("drops a resized name that is not a sized column", async () => {
				backingStore.set("column_widths", { ref: 200 });
				backingStore.set("resized_columns", ["ref", "message", "nonsense", 7]);

				expect(await loadUserWidths("/repo/a", floors)).toEqual({ ref: 200 });
			});

			it("finds none when the resized set is not a list", async () => {
				backingStore.set("column_widths", { ref: 200 });
				backingStore.set("resized_columns", { ref: true });

				expect(await loadUserWidths("/repo/a", floors)).toEqual({});
			});

			it("is left as it was by a save", async () => {
				backingStore.set("column_widths", { ref: 200 });
				backingStore.set("resized_columns", ["ref"]);

				await saveUserWidths("/repo/a", { author: 213 });

				expect(await loadUserWidths("/repo/b", floors)).toEqual({ ref: 200 });
			});
		});
	});

	describe("column visibility", () => {
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

describe("ref visibility", () => {
	beforeEach(() => {
		backingStore.clear();
	});

	it("a repository with nothing stored has everything visible", async () => {
		expect(await getRefVisibility("/repo")).toEqual(EVERYTHING_VISIBLE);
	});

	// Acceptance #7: closing and reopening the repository restores the same hidden set.
	it("returns what was stored for that repository", async () => {
		const hidden = toggleRef(EVERYTHING_VISIBLE, {
			name: "refs/remotes/origin/topic",
			short_name: "origin/topic",
			ref_type: "RemoteBranch",
			is_head: false,
			color_index: 0,
		});

		await setRefVisibility("/repo", hidden);

		expect(await getRefVisibility("/repo")).toEqual(hidden);
	});

	it("keys the hidden set per repository", async () => {
		const hidden = toggleStash(EVERYTHING_VISIBLE, "abc123");
		await setRefVisibility("/one", hidden);

		expect(await getRefVisibility("/two")).toEqual(EVERYTHING_VISIBLE);
		expect(await getRefVisibility("/one")).toEqual(hidden);
	});
});
