---
phase: 02-repository-open-commit-graph
verified: 2026-03-09T00:45:00Z
status: passed
score: 5/5 must-haves verified
re_verification:
  previous_status: passed
  previous_score: 5/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Open Repository triggers native OS file dialog and repo loads"
    expected: "Native folder picker appears; selecting a git repo shows commit graph"
    why_human: "OS dialog cannot be driven programmatically; requires live Tauri runtime"
    sign_off: "APPROVED -- confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Infinite scroll loads next 200-commit batch at threshold"
    expected: "Skeleton rows appear at scroll position 50 rows from end; batch loads silently"
    why_human: "Scroll events require real browser/WebView"
    sign_off: "APPROVED -- confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Lane topology is visually continuous across the batch boundary at commit ~200"
    expected: "SVG lane lines do not reset or break at the 200-commit boundary"
    why_human: "Pixel-level SVG correctness requires visual inspection"
    sign_off: "APPROVED -- confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Ref pills display correct colors (HEAD blue, branches green, remotes gray-blue, tags with icon)"
    expected: "Correct pill color per RefType; HEAD pill is accent blue + bold"
    why_human: "Visual rendering requires manual check"
    sign_off: "APPROVED -- confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "Recently opened repos persist across app restarts"
    expected: "Repo appears in recent list after quitting and relaunching app"
    why_human: "Requires Tauri runtime and app restart cycle"
    sign_off: "APPROVED -- confirmed in Plan 02-06 Task 3 checkpoint"
  - test: "SVG lane lines render with HEAD-priority column assignment and correct branch fork topology"
    expected: "HEAD chain at column 0; branch tips at higher columns; ForkLeft/ForkRight curves from branch tips toward main line"
    why_human: "SVG rendering requires visual inspection in WebView"
    sign_off: "Pending -- 02-08 fix verified via branch_fork_topology unit test but visual confirmation recommended"
---

# Phase 2: Repository Open + Commit Graph -- Verification Report

**Phase Goal:** Users can open a local Git repository and see a paginated commit graph with lane lines and ref labels.
**Verified:** 2026-03-09T00:45:00Z
**Status:** PASSED
**Re-verification:** Yes -- full re-verification of all artifacts and truths against actual codebase

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Clicking "Open Repository" triggers the native OS file dialog; selecting a valid Git repo loads it and displays the commit graph | VERIFIED | `WelcomeScreen.svelte` line 24: `open({ directory: true })` from `@tauri-apps/plugin-dialog`; line 34: `safeInvoke('open_repo', { path })`; `open_repo` command registered in `lib.rs` line 19; `validate_and_open` + `walk_commits` called in `repo.rs` lines 19-21; App.svelte line 181: WelcomeScreen renders when `repoPath === null`, line 191: CommitGraph renders when repoPath set |
| 2 | The commit graph paginates in batches of 200 and loads the next batch automatically as the user scrolls toward the end | VERIFIED | `CommitGraph.svelte` line 18: `BATCH = 200`; line 123: `loadMoreThreshold={50}`; line 122: `onLoadMore={loadMore}`; `history.rs` line 19: `(offset + 200).min(len)` slices cache; `SvelteVirtualList` handles virtual scroll; skeleton rows for initial (10 rows, line 74) and mid-scroll (3 rows, line 133) loading states |
| 3 | Lane topology is correct across all scroll positions: forks, merges, and continuations render without visual errors; HEAD chain occupies column 0 | VERIFIED | `graph.rs` computes `head_chain` HashSet (lines 35-44) and pre-populates `pending_parents` at col 0 (lines 51-57); non-HEAD branches skip col 0 (line 70-71); single-pass revwalk over ALL oids before slicing page; Straight edges for first-parent (lines 106-107, 133-137); ForkLeft/ForkRight for branch divergence (lines 109-111); 8 unit tests pass including `branch_fork_topology` and `merge_has_first_parent_straight` |
| 4 | Branch, tag, and stash labels appear inline on commits they point to; merge commits are visually distinct (larger dot with ring stroke) | VERIFIED | `RefPill.svelte` handles all 5 RefType cases: HEAD (accent blue + bold, line 14), LocalBranch (green-700, line 18), RemoteBranch (surface + border, line 20), Tag (green-700 + diamond prefix, lines 22,29), Stash (surface, line 24); `+N` overflow with tooltip (lines 38-43); `LaneSvg.svelte` line 52: `r={commit.is_merge ? 6 : 4}` and line 54: `stroke={commit.is_merge ? 'var(--color-bg)' : 'none'}` |
| 5 | Recently opened repositories are remembered and presented for quick re-open across app restarts | VERIFIED | `store.ts`: `LazyStore('trunk-prefs.json')` with `addRecentRepo`/`getRecentRepos`/`removeRecentRepo`; MAX_RECENT = 5; `capabilities/default.json` includes `store:default` permission (line 9); `WelcomeScreen.svelte` imports all three functions (line 4) and uses them: `getRecentRepos` on mount (line 17), `addRecentRepo` on open (line 36), `removeRecentRepo` on remove button (line 49) |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/repository.rs` | `validate_and_open`, `build_ref_map` helpers | VERIFIED | Both functions implemented (lines 5-11, 13-59); `build_ref_map` handles LocalBranch, RemoteBranch, Tag, Stash ref types; 2 tests pass (`ref_map_head`, `ref_map_stash`); `make_test_repo` + `make_large_test_repo` helpers for shared test infrastructure |
| `src-tauri/src/git/graph.rs` | `walk_commits` with full lane algorithm + HEAD-priority column assignment | VERIFIED | 217 lines production code + 206 lines tests; single-pass full revwalk + lane assignment; `head_chain` pre-computation for column 0 reservation; ForkLeft/ForkRight edges; Straight edges for first-parent; 8 unit tests pass |
| `src-tauri/src/commands/repo.rs` | `open_repo`, `close_repo` Tauri commands | VERIFIED | Both commands implemented with `spawn_blocking` for git2 work; watcher integration via `watcher::start_watcher`/`stop_watcher`; 3 tests pass |
| `src-tauri/src/commands/history.rs` | `get_commit_graph` Tauri command | VERIFIED | 21 lines; slices `CommitCache` by offset with page size 200; returns `Vec<GraphCommit>` |
| `src-tauri/src/state.rs` | `RepoState` + `CommitCache` structs | VERIFIED | Both present with `Mutex<HashMap<...>>` wrapping; `CommitCache` stores `Vec<GraphCommit>` per path (line 12) |
| `src-tauri/src/lib.rs` | `open_repo`, `close_repo`, `get_commit_graph` in `generate_handler!` | VERIFIED | All three commands registered at lines 19-21 |
| `src-tauri/capabilities/default.json` | `store:default` permission | VERIFIED | Present at line 9 alongside `dialog:allow-open` |
| `src/lib/store.ts` | `addRecentRepo`, `getRecentRepos`, `removeRecentRepo` via `LazyStore` | VERIFIED | All three exported; `trunk-prefs.json` store; MAX_RECENT = 5; proper deduplication in `addRecentRepo` (line 11) |
| `src/components/WelcomeScreen.svelte` | Open button + recent repos list + error state | VERIFIED | 113 lines; dialog open (line 24), `safeInvoke` (line 34), `addRecentRepo` (line 36), loading + error states, recent list with remove button |
| `src/components/TabBar.svelte` | Single tab with repo name + X close button | VERIFIED | `repoName` prop, `onclose` prop, X button calls `onclose()` (line 29); accent border for active tab |
| `src/components/CommitGraph.svelte` | Virtual list + 200-item pagination + skeleton + error | VERIFIED | `SvelteVirtualList` (line 118), `BATCH=200` (line 18), skeleton rows for initial (10) and mid-scroll (3), retry button (line 156), WIP row (lines 96-117), auto-scroll to HEAD (lines 53-68) |
| `src/components/CommitRow.svelte` | Three-column row: ref pills, SVG lane, message | VERIFIED | Three columns: `RefPill` at 120px fixed (line 20), `LaneSvg` flex-shrink-0 (line 25), message flex-1 with short_oid + summary (lines 28-32) |
| `src/components/LaneSvg.svelte` | Inline SVG with Straight lines, Bezier curves, merge dot | VERIFIED | Straight edges as `<line>` (lines 29-36), non-Straight as Bezier `<path>` (lines 38-44); merge dot r=6+ring-stroke (lines 52-56), regular r=4 |
| `src/components/RefPill.svelte` | Colored pill per RefType + +N overflow | VERIFIED | All 5 cases handled with distinct styling; diamond prefix for tags (line 29); +N with title tooltip (lines 38-43) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib.rs` | `commands::repo::open_repo`, `close_repo`, `history::get_commit_graph` | `tauri::generate_handler![]` | WIRED | Lines 19-21 in `lib.rs` |
| `lib.rs` | `CommitCache` | `.manage(CommitCache(Default::default()))` | WIRED | Line 16 in `lib.rs` |
| `commands/repo.rs open_repo` | `git::graph::walk_commits` | `graph::walk_commits(&mut repo, 0, usize::MAX)` inside `spawn_blocking` | WIRED | Line 21 of `repo.rs` |
| `commands/repo.rs open_repo` | `git::repository::validate_and_open` | `repository::validate_and_open(&path_buf)?` | WIRED | Line 19 of `repo.rs` |
| `commands/history.rs get_commit_graph` | `state::CommitCache` | `cache.0.lock().unwrap()` | WIRED | Line 12 of `history.rs` |
| `git/graph.rs walk_commits` | `git/repository.rs build_ref_map` | `repository::build_ref_map(repo)` at top of walk | WIRED | Line 12 of `graph.rs` |
| `App.svelte` | `CommitGraph.svelte` | `<CommitGraph {repoPath} ...>` rendered in main area | WIRED | Line 191 of `App.svelte` |
| `App.svelte` | `WelcomeScreen.svelte` | Rendered when `repoPath === null` | WIRED | Line 181 of `App.svelte` |
| `App.svelte` | `TabBar.svelte` | Rendered with `onclose={handleClose}` when `repoPath` is set | WIRED | Line 183 of `App.svelte` |
| `WelcomeScreen.svelte` | `store.ts` | Imports `addRecentRepo`, `getRecentRepos`, `removeRecentRepo` | WIRED | Line 4 of `WelcomeScreen.svelte` |
| `CommitGraph.svelte` | `get_commit_graph` Rust command | `safeInvoke('get_commit_graph', { path: repoPath, offset })` | WIRED | Lines 34-37 of `CommitGraph.svelte` |
| `CommitRow.svelte` | `LaneSvg.svelte` | `<LaneSvg {commit} />` | WIRED | Line 25 of `CommitRow.svelte` |
| `CommitRow.svelte` | `RefPill.svelte` | `<RefPill refs={commit.refs} />` | WIRED | Line 21 of `CommitRow.svelte` |

---

### Unit Test Results

All 41 crate tests pass (`cargo test -p trunk --lib` from `src-tauri/`). Phase 2 specific tests (12 of 41):

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
| `merge_has_first_parent_straight` | `git::graph::tests` | ok |
| `branch_fork_topology` | `git::graph::tests` | ok |

**Test result: 41 passed, 0 failed** (all crate tests including later phases)

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REPO-01 | 02-01, 02-03, 02-06 | Open a repo via native file picker | SATISFIED | `open({ directory: true })` in WelcomeScreen; `validate_and_open` + `walk_commits` in backend; `open_repo` command registered in `generate_handler!` |
| REPO-02 | 02-01, 02-03, 02-04, 02-06 | Close a repo and return to welcome state | SATISFIED | `close_repo` command removes state/cache/watcher; `handleClose` in App.svelte resets `repoPath` to null |
| REPO-03 | 02-02, 02-04, 02-06 | Recently opened repos remembered across restarts | SATISFIED | `LazyStore('trunk-prefs.json')` with `store:default` capability; `addRecentRepo` called on open; `getRecentRepos` on mount; MAX_RECENT = 5 |
| GRAPH-01 | 02-01, 02-02, 02-03, 02-05, 02-07 | Commit graph with virtual scroll + 200-item pagination | SATISFIED | `walk_commits` revwalks all oids; `get_commit_graph` slices by offset+200; `SvelteVirtualList` with `onLoadMore`+threshold=50 |
| GRAPH-02 | 02-01, 02-03, 02-05, 02-07, 02-08 | Topologically correct lane rendering | SATISFIED | Single-pass full revwalk; HEAD-priority column assignment via `head_chain`; Straight edges for first-parent; ForkLeft/ForkRight for branch divergence; MergeLeft/MergeRight for merges; 8 unit tests verify topology |
| GRAPH-03 | 02-01, 02-03, 02-05 | Branch, tag, stash ref labels inline on commits | SATISFIED | `build_ref_map` collects all ref types; `RefPill` renders per-type styling with overflow |
| GRAPH-04 | 02-01, 02-03, 02-05 | Merge commits visually distinct | SATISFIED | `is_merge` flag on 2+ parent commits; `LaneSvg` uses r=6+ring-stroke for merge dots |

All 7 requirements accounted for. No orphaned requirements (REQUIREMENTS.md maps exactly these 7 IDs to Phase 2).

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src-tauri/src/commands/mod.rs` | -- | Unused imports: `get_commit_graph`, `open_repo`, `close_repo` | INFO | Compiler warnings only; commands are registered via full path in `lib.rs`. Does not affect functionality. |
| `src/components/LaneSvg.svelte` | 13 | `const cy = rowHeight / 2` captures initial value, not reactive | INFO | Svelte compiler note; `rowHeight` prop has default 26 and is never dynamically changed per-row. Functionally correct. |

No TODO/FIXME/placeholder comments found. No empty implementations. No stub handlers. No `return null` or `return {}` patterns.

---

### Build Status

| Build | Result |
|-------|--------|
| `cargo build -p trunk` (from `src-tauri/`) | PASS (2 unused import warnings in `commands/mod.rs`) |
| `bun run build` | PASS (147 modules, 1.85s) |
| `cargo test -p trunk --lib` (from `src-tauri/`) | PASS (41/41, including 12 phase-2 tests) |

---

### Human Verification Required

### 1. SVG Lane Lines with HEAD-Priority Column Assignment

**Test:** Open a repository with multiple branches (some merged, some unmerged). Verify that the HEAD/main branch occupies the leftmost column (column 0) and branch tips fork from it with curved connections.
**Expected:** HEAD chain forms a continuous vertical line at column 0. Branch tips appear at higher columns with Bezier curves connecting them back to their fork point on main.
**Why human:** The 02-08 fix for HEAD-priority column assignment is verified via the `branch_fork_topology` unit test, but visual confirmation in the WebView is recommended for pixel-level SVG correctness.

### 2. Lane Continuity Across Batch Boundary

**Test:** Open a repository with 200+ commits. Scroll past the ~200th commit boundary.
**Expected:** Lane lines remain visually continuous with no breaks, jumps, or misaligned lanes at the batch boundary.
**Why human:** The graph algorithm processes ALL oids in a single pass before slicing by page, which ensures lane continuity. However, the visual rendering at the boundary needs human inspection.

---

## Gaps Summary

No gaps. All 5 observable truths verified against actual codebase with independent code inspection. All 14 required artifacts exist, are substantive (non-stub, real implementations), and are wired (imported and used). All 13 key links are connected. All 7 requirements satisfied. All 12 phase-2 unit tests pass (within a full test suite of 41). Both builds (Rust + frontend) succeed.

The previous verification (2026-03-08) documented the same status. This re-verification independently confirmed all claims by reading every artifact and running tests fresh.

---

## VERDICT: PASS

Phase 2 goal is achieved. Users can open a local Git repository and see a paginated commit graph with lane lines and ref labels. All 5 success criteria are met. All 7 requirements (REPO-01, REPO-02, REPO-03, GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04) are satisfied. The lane topology algorithm includes HEAD-priority column assignment (02-08 fix) and first-parent Straight edge emission (02-07 fix), both verified by regression tests.

---

_Verified: 2026-03-09T00:45:00Z_
_Verifier: Claude (gsd-verifier)_
