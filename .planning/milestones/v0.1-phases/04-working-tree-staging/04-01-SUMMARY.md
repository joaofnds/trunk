---
phase: 04-working-tree-staging
plan: "01"
subsystem: rust-backend
tags: [staging, git2, tauri-commands, tdd, inner-fn-pattern]
dependency_graph:
  requires: []
  provides: [get_status, stage_file, unstage_file, stage_all, unstage_all]
  affects: [src-tauri/src/commands/staging.rs, src-tauri/src/lib.rs]
tech_stack:
  added: []
  patterns: [inner-fn-pattern, spawn-blocking, status-bitflag-classification]
key_files:
  created:
    - src-tauri/src/commands/staging.rs
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/src/watcher.rs
decisions:
  - "is_head_unborn() does not exist in git2 0.19.0 — detect via repo.head() returning ErrorCode::UnbornBranch"
  - "stage_all uses add_all(*) not update_all + add_all — update_all alone misses new untracked files"
  - "unstage_all collects staged paths via get_status_inner then passes to reset_default — no direct index-clear on repos with commits"
metrics:
  duration: "4 minutes"
  completed: "2026-03-05"
  tasks_completed: 2
  files_modified: 3
---

# Phase 4 Plan 01: Staging Commands Backend Summary

**One-liner:** Staging backend with git2 status-bitflag classification, index operations, and reset_default for unstage on committed repos.

## What Was Built

Five Tauri commands implemented in `src-tauri/src/commands/staging.rs` following the inner fn TDD pattern from branches.rs:

- `get_status_inner` — iterates `repo.statuses()` with `include_untracked(true)`, classifies each entry via INDEX_* bits (staged), WT_* bits (unstaged), CONFLICTED (conflicted)
- `stage_file_inner` — `index.add_path(Path::new(file_path))` + `index.write()`
- `unstage_file_inner` — checks `is_head_unborn` via ErrorCode::UnbornBranch; uses `index.remove_path` for unborn repos, `reset_default` for committed repos
- `stage_all_inner` — `index.add_all(["*"])` + `index.write()`
- `unstage_all_inner` — `index.clear` for unborn repos; `reset_default` on all staged paths for committed repos

Each inner function has a corresponding `#[tauri::command]` wrapper using `spawn_blocking` + error mapping (identical to branches.rs pattern).

All 5 commands registered in `lib.rs` `invoke_handler`.

## Tasks

| Task | Description | Commit | Result |
|------|-------------|--------|--------|
| 1 (RED) | Write 8 failing tests | 941072d | 8/8 fail as expected |
| 2 (GREEN) | Implement inner functions | fb7f916 | 8/8 pass, 25/25 suite |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `is_head_unborn()` does not exist in git2 0.19.0**
- **Found during:** Task 2 (GREEN phase, first compile attempt)
- **Issue:** PLAN.md / RESEARCH.md specified `repo.is_head_unborn()` but the method does not exist in git2 0.19.0
- **Fix:** Added local helper `fn is_head_unborn(repo: &git2::Repository) -> bool` that calls `repo.head()` and checks `e.code() == git2::ErrorCode::UnbornBranch`
- **Files modified:** src-tauri/src/commands/staging.rs
- **Commit:** fb7f916

**2. [Rule 3 - Blocking] `watcher.rs` missing `use tauri::Emitter` import**
- **Found during:** Task 2 (GREEN phase, compile step)
- **Issue:** Pre-existing compilation error — `app.emit(...)` requires `tauri::Emitter` trait in scope; absent import blocked the entire test build
- **Fix:** Added `Emitter` to the `use tauri::{AppHandle, Emitter};` import in watcher.rs
- **Files modified:** src-tauri/src/watcher.rs
- **Commit:** fb7f916

## Key Decisions

1. `is_head_unborn()` — detect via `repo.head()` returning `ErrorCode::UnbornBranch` (git2 0.19.0 does not expose this as a repo method directly)
2. `stage_all_inner` — use `index.add_all(["*"])` which picks up new untracked files; `update_all` alone only updates already-tracked files
3. `unstage_all_inner` — collect staged paths via `get_status_inner` result then call `reset_default` once (avoids reopening repo per file)

## Verification

```
cargo test -- staging::tests
# result: ok. 8 passed; 0 failed

cargo test
# result: ok. 25 passed; 0 failed
```

## Self-Check

### Files exist
- [x] src-tauri/src/commands/staging.rs
- [x] src-tauri/src/lib.rs (modified)
- [x] src-tauri/src/watcher.rs (modified)

### Commits exist
- [x] 941072d — RED phase (8 failing tests)
- [x] fb7f916 — GREEN phase (implementation + lib.rs registration + watcher fix)
