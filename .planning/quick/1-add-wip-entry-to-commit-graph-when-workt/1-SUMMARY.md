---
phase: quick-1
plan: 1
subsystem: commit-graph / staging
tags: [wip-row, commit-graph, dirty-counts, rust-command, svelte]
dependency_graph:
  requires: []
  provides: [get_dirty_counts IPC command, WIP row in CommitGraph]
  affects: [src/components/CommitGraph.svelte, src/App.svelte]
tech_stack:
  added: []
  patterns: [safeInvoke IPC pattern, $derived reactive state, $effect for repo-changed]
key_files:
  created: []
  modified:
    - src-tauri/src/commands/staging.rs
    - src-tauri/src/lib.rs
    - src/components/CommitGraph.svelte
    - src/App.svelte
decisions:
  - get_dirty_counts adapts existing RepoState Mutex<HashMap> pattern (not state.path()) to match actual codebase
  - Explicit TrunkError type annotation on map_err closure required due to Rust type inference limitation
  - Pre-existing svelte-check ERROR in CommitGraph (listRef type mismatch with SvelteVirtualList) is out of scope — present before this plan
metrics:
  duration: 10min
  completed: 2026-03-08
  tasks_completed: 2
  files_modified: 4
---

# Quick Task 1: Add WIP Entry to Commit Graph Summary

**One-liner:** Synthetic "// WIP" row with file count badge rendered above commit graph using a new `get_dirty_counts` Rust command and `wipCount` prop wiring.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Add get_dirty_counts Rust command | b07d342 | staging.rs, lib.rs |
| 2 | WIP row in CommitGraph + App.svelte wiring | 814b4f1 | CommitGraph.svelte, App.svelte |

## What Was Built

### Task 1: get_dirty_counts Rust Command

Added `DirtyCounts { staged, unstaged, conflicted }` struct and `get_dirty_counts` Tauri command to `staging.rs`. The command opens the repo, iterates git2 statuses, and counts entries by category using `Status::intersects`. Registered in `lib.rs` `generate_handler![]`.

### Task 2: WIP Row + App.svelte Wiring

**CommitGraph.svelte:**
- Added `wipCount: number` (default 0) and `onWipClick: () => void` props
- Renders a WIP row above the `SvelteVirtualList` when `wipCount > 0`
- Row shows lane-0 colored dot (with downward connecting line to HEAD), italic "// WIP" label, and a pill badge showing file count
- Hover state and keyboard (Enter) support included
- Scoped CSS using `color-mix` with `var(--lane-0)` for brand-consistent tinting

**App.svelte:**
- Added `DirtyCounts` TypeScript interface
- Added `dirtyCounts` reactive state, initialized to all zeros
- Added `loadDirtyCounts()` async function calling `safeInvoke<DirtyCounts>('get_dirty_counts')`
- Added `wipCount` derived from sum of all three counts
- `$effect` triggers `loadDirtyCounts()` when `repoPath` is set (on mount)
- Existing `repo-changed` listener now also calls `loadDirtyCounts()`
- CommitGraph receives `{wipCount}` and `onWipClick={clearCommit}`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Adapted Rust command to actual RepoState pattern**
- **Found during:** Task 1
- **Issue:** Plan template used `state.path()` method which does not exist; actual `RepoState` is `Mutex<HashMap<String, PathBuf>>` accessed via `state.0.lock().unwrap().clone()`
- **Fix:** Used `open_repo_from_state` helper (already exists in staging.rs) with the state map pattern
- **Files modified:** src-tauri/src/commands/staging.rs

**2. [Rule 1 - Bug] Added explicit TrunkError type annotation**
- **Found during:** Task 1 — cargo build failed with E0282 type inference error
- **Issue:** Rust couldn't infer the error type in `.map_err(|e| serde_json::to_string(&e).unwrap())`
- **Fix:** Changed to `.map_err(|e: TrunkError| ...)`
- **Files modified:** src-tauri/src/commands/staging.rs

## Self-Check

```
b07d342  feat(quick-1): add get_dirty_counts Tauri command
814b4f1  feat(quick-1): add WIP row to CommitGraph and wire in App.svelte
```

Files exist:
- src-tauri/src/commands/staging.rs — FOUND
- src-tauri/src/lib.rs — FOUND
- src/components/CommitGraph.svelte — FOUND
- src/App.svelte — FOUND

## Self-Check: PASSED
