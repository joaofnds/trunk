---
phase: 02-repository-open-commit-graph
verified: 2026-03-04T09:45:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
human_verification:
  - test: "Open Repository triggers native OS file dialog and repo loads"
    expected: "Native folder picker appears; selecting a git repo shows commit graph"
    why_human: "OS dialog cannot be driven programmatically; requires live Tauri runtime"
    sign_off: "APPROVED — confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Infinite scroll loads next 200-commit batch at threshold"
    expected: "Skeleton rows appear at scroll position 50 rows from end; batch loads silently"
    why_human: "Scroll events require real browser/WebView"
    sign_off: "APPROVED — confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Lane topology is visually continuous across the batch boundary at commit ~200"
    expected: "SVG lane lines do not reset or break at the 200-commit boundary"
    why_human: "Pixel-level SVG correctness requires visual inspection"
    sign_off: "APPROVED — confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Ref pills display correct colors (HEAD blue, branches green, remotes gray-blue, tags with icon)"
    expected: "Correct pill color per RefType; HEAD pill is accent blue + bold"
    why_human: "Visual rendering requires manual check"
    sign_off: "APPROVED — confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Recently opened repos persist across app restarts"
    expected: "Repo appears in recent list after quitting and relaunching app"
    why_human: "Requires Tauri runtime and app restart cycle"
    sign_off: "APPROVED — confirmed in Plan 02-06 Task 3 checkpoint"
---

# Phase 2: Repository Open + Commit Graph — Verification Report

**Phase Goal:** A developer can open any local Git repository via a native file picker and immediately see its full commit history as a scrollable visual lane graph

**Verified:** 2026-03-04T09:45:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Clicking "Open Repository" triggers the native OS file dialog; selecting a valid Git repo loads it and displays the commit graph | VERIFIED | `WelcomeScreen.svelte` calls `open({ directory: true })` from `@tauri-apps/plugin-dialog`; `safeInvoke('open_repo')` wired; `open_repo` command registered in `lib.rs`; human sign-off confirmed |
| 2 | The commit graph paginates in batches of 200 and loads the next batch automatically as the user scrolls toward the end | VERIFIED | `CommitGraph.svelte`: `BATCH=200`, `loadMoreThreshold={50}`, `SvelteVirtualList` with `onLoadMore={loadMore}`; `get_commit_graph` slices cache by offset+200; human sign-off confirmed |
| 3 | Lane topology is correct across all scroll positions: forks, merges, and continuations render without visual errors | VERIFIED | `walk_commits` runs single pass over ALL oids before slicing page; `pending_parents` map preserves column assignments across batches; unit tests `walk_first_batch`, `walk_second_batch`, `linear_topology`, `merge_commit_edges` all pass; human sign-off confirmed |
| 4 | Branch, tag, and stash labels appear inline on commits they point to; merge commits are visually distinct (larger dot with ring stroke) | VERIFIED | `RefPill.svelte` renders per-RefType pill styling; `LaneSvg.svelte` uses `r={commit.is_merge ? 6 : 4}` and `stroke={commit.is_merge ? 'var(--color-bg)' : 'none'}`; human sign-off confirmed |
| 5 | Recently opened repositories are remembered and presented for quick re-open across app restarts | VERIFIED | `store.ts` uses `LazyStore('trunk-prefs.json')` with `addRecentRepo`/`getRecentRepos`; `store:default` capability in `capabilities/default.json`; human sign-off confirmed |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/repository.rs` | `validate_and_open`, `build_ref_map` helpers | VERIFIED | Both functions implemented, exported, and tested |
| `src-tauri/src/git/graph.rs` | `walk_commits` with full lane algorithm | VERIFIED | Single-pass full revwalk + lane assignment; 5 unit tests pass |
| `src-tauri/src/commands/repo.rs` | `open_repo`, `close_repo` Tauri commands | VERIFIED | Both commands implemented; call `spawn_blocking` for git2 work |
| `src-tauri/src/commands/history.rs` | `get_commit_graph` Tauri command | VERIFIED | Slices `CommitCache` by offset with hard-coded page size of 200 |
| `src-tauri/src/state.rs` | `RepoState` + `CommitCache` structs | VERIFIED | Both present; `CommitCache` caches full `Vec<GraphCommit>` per path |
| `src-tauri/src/lib.rs` | `open_repo`, `close_repo`, `get_commit_graph` in `generate_handler!` | VERIFIED | All three commands registered; `CommitCache` managed state registered |
| `src-tauri/capabilities/default.json` | `store:default` permission | VERIFIED | Present — was added as a bug fix in 02-06 |
| `src/lib/store.ts` | `addRecentRepo`, `getRecentRepos`, `removeRecentRepo` via `LazyStore` | VERIFIED | All three exported; `trunk-prefs.json` store; MAX_RECENT = 5 |
| `src/components/WelcomeScreen.svelte` | Open button + recent repos list + error state | VERIFIED | Full implementation: dialog open, `safeInvoke`, `addRecentRepo`, loading + error states |
| `src/components/TabBar.svelte` | Single tab with repo name + X close button | VERIFIED | `repoName` prop, `onclose` prop, X button calls `onclose()` |
| `src/components/CommitGraph.svelte` | Virtual list + 200-item pagination + skeleton + error | VERIFIED | `SvelteVirtualList`, `BATCH=200`, skeleton rows (10 initial, 3 mid-scroll), retry button |
| `src/components/CommitRow.svelte` | Three-column row: ref pills, SVG lane, message | VERIFIED | Exactly three columns: `RefPill` at 120px fixed, `LaneSvg` flex-shrink-0, message flex-1 |
| `src/components/LaneSvg.svelte` | Inline SVG with Straight lines, Bezier curves, merge dot | VERIFIED | Straight edges as `<line>`, all others as Bezier `<path>`; merge dot r=6+ring, regular r=4 |
| `src/components/RefPill.svelte` | Colored pill per RefType + +N overflow | VERIFIED | All 5 cases handled (HEAD, LocalBranch, RemoteBranch, Tag, Stash); `+N` with `title` tooltip |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib.rs` | `commands::repo::open_repo`, `close_repo`, `history::get_commit_graph` | `tauri::generate_handler![]` | WIRED | All three commands present in handler (verified directly in `lib.rs` lines 16–20) |
| `lib.rs` | `CommitCache` | `.manage(CommitCache(Default::default()))` | WIRED | Line 15 in `lib.rs` |
| `commands/repo.rs open_repo` | `git::graph::walk_commits` | `graph::walk_commits(&mut repo, 0, usize::MAX)` inside `spawn_blocking` | WIRED | Lines 18–22 of `repo.rs` |
| `commands/history.rs get_commit_graph` | `state::CommitCache` | `cache.0.lock().unwrap()` | WIRED | Lines 12–20 of `history.rs` |
| `git/graph.rs walk_commits` | `git/repository.rs build_ref_map` | `repository::build_ref_map(repo)` at top of walk | WIRED | Line 12 of `graph.rs` |
| `src/App.svelte` | `CommitGraph.svelte` | `<CommitGraph {repoPath} />` rendered in graph slot | WIRED | Line 34 of `App.svelte` |
| `src/App.svelte` | `WelcomeScreen.svelte` | Rendered when `repoPath === null` | WIRED | Lines 29–31 of `App.svelte` |
| `src/App.svelte` | `TabBar.svelte` | Rendered with `onclose={handleClose}` when `repoPath` is set | WIRED | Lines 32–33 of `App.svelte` |
| `WelcomeScreen.svelte` | `store.ts` | Imports `getRecentRepos`, `addRecentRepo`, `removeRecentRepo` | WIRED | Line 4 of `WelcomeScreen.svelte` |
| `CommitGraph.svelte` | `get_commit_graph` Rust command | `safeInvoke('get_commit_graph', { path: repoPath, offset })` | WIRED | Lines 27–30 of `CommitGraph.svelte` |
| `CommitRow.svelte` | `LaneSvg.svelte` | `<LaneSvg {commit} />` | WIRED | Line 23 of `CommitRow.svelte` |
| `CommitRow.svelte` | `RefPill.svelte` | `<RefPill refs={commit.refs} />` | WIRED | Line 19 of `CommitRow.svelte` |

---

### Unit Test Results

All 10 unit tests pass (`cargo test -p trunk --lib`):

| Test | Module | Status |
|------|--------|--------|
| `open_invalid_path` | `commands::repo::tests` | ok |
| `open_valid_repo` | `commands::repo::tests` | ok |
| `close_removes_state` | `commands::repo::tests` | ok |
| `ref_map_head` | `git::repository::tests` | ok |
| `ref_map_stash` | `git::repository::tests` | ok |
| `linear_topology` | `git::graph::tests` | ok |
| `merge_commit_edges` | `git::graph::tests` | ok |
| `is_merge_flag` | `git::graph::tests` | ok |
| `walk_first_batch` | `git::graph::tests` | ok |
| `walk_second_batch` | `git::graph::tests` | ok |

**Test result: 10 passed, 0 failed**

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status |
|-------------|-------------|-------------|--------|
| REPO-01 | 02-01, 02-03, 02-06 | Open a repo via native file picker | SATISFIED — `open()` dialog in WelcomeScreen; `validate_and_open` in backend; `open_repo` command registered |
| REPO-02 | 02-03, 02-04, 02-06 | Close a repo and return to welcome state | SATISFIED — `close_repo` command; `handleClose` in App.svelte resets `repoPath` to null |
| REPO-03 | 02-02, 02-04 | Recently opened repos remembered across restarts | SATISFIED — `LazyStore('trunk-prefs.json')` with `store:default` capability; addRecentRepo called on open |
| GRAPH-01 | 02-01, 02-03, 02-05 | Commit graph with virtual scroll + 200-item pagination | SATISFIED — `walk_commits` paginates; `get_commit_graph` slices cache; `SvelteVirtualList` with `onLoadMore`+threshold |
| GRAPH-02 | 02-01, 02-03, 02-05 | Topologically correct lane rendering | SATISFIED — single-pass full revwalk preserves lane state; Bezier curves for fork/merge edges; unit tests verify |
| GRAPH-03 | 02-01, 02-03, 02-05 | Branch, tag, stash ref labels inline on commits | SATISFIED — `build_ref_map` collects all ref types; `RefPill` renders per-type styling |
| GRAPH-04 | 02-01, 02-03, 02-05 | Merge commits visually distinct | SATISFIED — `is_merge` flag set on 2+ parent commits; `LaneSvg` uses r=6+ring-stroke for merge dots |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/components/LaneSvg.svelte` | 13 | `const cy = rowHeight / 2` captures initial value, not reactive | INFO | Svelte compiler warning; `rowHeight` has a default of 26 and is only set via prop — functionally correct since prop doesn't change per render, but Svelte flags it as a lint warning |

No TODO/FIXME/placeholder comments found in implementation files. No empty implementations (`return null`, `return {}`) found. No stub handlers found.

---

### Human Verification Sign-Off

All 5 human verification items were approved in the Plan 02-06 Task 3 checkpoint:

1. **Native OS file dialog** — Opened and returned correct path
2. **Commit graph renders** — ref pills, SVG lanes, merge dot+ring visible
3. **Infinite scroll** — Next 200-commit batch auto-loads at 50-row threshold
4. **Lane topology at batch boundary** — Continuous across commit ~200, no column resets
5. **Close + recent repos + persist** — X closes to welcome; recent list populated; persists across restart

All 8 checkpoints in the plan's how-to-verify checklist were confirmed as passing.

---

## Gaps Summary

No gaps. All 5 observable truths verified. All 14 required artifacts exist and are substantive and wired. All 12 key links are connected. All 7 requirements satisfied. All 10 unit tests pass. Build is clean (`cargo build` and `bun run build` both exit 0). Human sign-off confirmed all interactive behaviors.

One non-blocking lint warning exists in `LaneSvg.svelte` (Svelte `state_referenced_locally` for `const cy = rowHeight / 2`) — this is cosmetic, functionally correct, and does not affect goal achievement.

---

## VERDICT: PASS

Phase 2 goal is achieved. A developer can open any local Git repository via a native file picker and immediately see its full commit history as a scrollable visual lane graph. All success criteria from ROADMAP.md are met.

---

_Verified: 2026-03-04T09:45:00Z_
_Verifier: Claude (gsd-verifier)_
