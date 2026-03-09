---
phase: 04-working-tree-staging
plan: "02"
subsystem: infra
tags: [rust, tauri, notify-debouncer-mini, filesystem-watcher, ipc]

# Dependency graph
requires:
  - phase: 04-working-tree-staging-01
    provides: staging commands backend (staging.rs with 5 commands)
provides:
  - WatcherState type (Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>) with Default impl
  - start_watcher: starts 300ms debounced FS watcher, emits repo-changed event to frontend
  - stop_watcher: drops Debouncer (stopping the watch thread)
  - open_repo starts watcher after inserting into RepoState and CommitCache
  - close_repo stops watcher after removing from state
  - WatcherState managed via app.manage() in lib.rs
  - All 5 staging commands registered in generate_handler!
affects:
  - 04-working-tree-staging-03 (frontend staging panel needs repo-changed event)
  - 04-working-tree-staging-04 (commit form depends on staging being wired)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Debouncer stored in WatcherState (not returned/dropped) — dropping stops watcher silently"
    - "AppHandle + Emitter trait required for app.emit() in Tauri 2"
    - "stop_watcher drops Debouncer by removing from HashMap — OS watcher thread stops on drop"

key-files:
  created: []
  modified:
    - src-tauri/src/watcher.rs
    - src-tauri/src/commands/repo.rs
    - src-tauri/src/lib.rs

key-decisions:
  - "WatcherState uses Default impl (not manual) so app.manage(WatcherState(Default::default())) is clean"
  - "start_watcher clones path_buf for state insert after watch() call to avoid borrow conflict"
  - "open_repo clones path_buf before cache.insert (which consumes path) so watcher can use path_buf"

patterns-established:
  - "Watcher lifecycle tied to repo open/close — watcher starts in open_repo, stops in close_repo"
  - "Tauri Emitter trait must be in scope for AppHandle::emit() in Tauri 2"

requirements-completed:
  - STAGE-04

# Metrics
duration: 5min
completed: "2026-03-05"
---

# Phase 4 Plan 02: Filesystem Watcher + Staging Registration Summary

**Notify-debouncer-mini watcher with 300ms debounce emitting repo-changed Tauri events, wired into open_repo/close_repo lifecycle, with WatcherState managed and all 5 staging commands registered**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-05T04:00:00Z
- **Completed:** 2026-03-05T04:07:24Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- WatcherState type defined with Default impl using notify-debouncer-mini Debouncer stored in HashMap
- start_watcher creates 300ms debouncer that emits "repo-changed" Tauri event on FS changes
- stop_watcher removes Debouncer from map — OS thread stops on drop
- open_repo now starts watcher after inserting into RepoState and CommitCache
- close_repo now stops watcher after removing from state
- lib.rs manages WatcherState and has all 5 staging commands in generate_handler!
- All 25 tests pass, build clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement WatcherState in watcher.rs** — already implemented by 04-01 agent's Rule 3 deviation fix (watcher.rs was a blocking dependency for compilation, included in `fb7f916`)
2. **Task 2: Wire watcher into open_repo/close_repo and register staging commands** - `05c573e` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `src-tauri/src/watcher.rs` - WatcherState type, start_watcher (300ms debounce, emits repo-changed), stop_watcher
- `src-tauri/src/commands/repo.rs` - Added watcher_state + app params to open_repo; added watcher_state param to close_repo; calls start/stop watcher
- `src-tauri/src/lib.rs` - Added .manage(WatcherState(Default::default())); all 5 staging commands in generate_handler!

## Decisions Made

- WatcherState uses `Default` impl (not manual construction) for ergonomic `WatcherState(Default::default())` in lib.rs
- `path_buf` is cloned before `cache.0.lock().unwrap().insert(path, commits)` to avoid use-after-move; watcher gets the cloned PathBuf
- Tauri 2 `AppHandle::emit()` requires `use tauri::Emitter;` trait in scope (linter auto-applied this)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] watcher.rs Task 1 already implemented by 04-01 agent**
- **Found during:** Task 1 verification
- **Issue:** Plan 04-01 agent implemented watcher.rs as a Rule 3 deviation (it was blocking the staging commands compilation). Task 1 of this plan was already complete.
- **Fix:** Verified existing implementation matched plan spec exactly. Proceeded directly to Task 2.
- **Files modified:** None — already done
- **Committed in:** fb7f916 (04-01 plan, staging backend commit)

---

**Total deviations:** 1 (pre-executed task by prior agent)
**Impact on plan:** No scope creep. Task 1 was legitimately pre-completed as a blocking-fix deviation. Task 2 executed as planned.

## Issues Encountered

- Tauri 2 `AppHandle::emit()` method requires the `Emitter` trait in scope. The linter auto-added `use tauri::{AppHandle, Emitter};` to watcher.rs during 04-01's execution.

## User Setup Required

None - no external service configuration required. Watcher functionality requires manual verification against a real Tauri runtime (macOS FSEvents in tauri dev mode).

## Next Phase Readiness

- Watcher backbone complete: frontend can listen for "repo-changed" events to trigger status refresh
- All 5 staging commands registered and accessible from frontend IPC
- Ready for Phase 4 Plan 03: staging panel UI (StagingPanel.svelte)
- Note: macOS sandbox behavior for FSEvents in production .app builds should be validated against a production build

---
*Phase: 04-working-tree-staging*
*Completed: 2026-03-05*
