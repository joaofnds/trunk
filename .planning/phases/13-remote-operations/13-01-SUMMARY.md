---
phase: 13-remote-operations
plan: 01
subsystem: api
tags: [tokio, async, git-cli, subprocess, tauri-events, streaming]

# Dependency graph
requires:
  - phase: 12-commit-context-menu
    provides: "Established git CLI subprocess pattern with GIT_TERMINAL_PROMPT=0"
provides:
  - "git_fetch, git_pull, git_push, cancel_remote_op Tauri commands"
  - "RunningOp state for remote operation mutual exclusion and cancel"
  - "classify_git_error error taxonomy (auth_failure, non_fast_forward, no_upstream, remote_error)"
  - "remote-progress Tauri event for real-time progress streaming"
affects: [13-remote-operations, 14-tracking-toolbar]

# Tech tracking
tech-stack:
  added: [tokio (process, io-util), libc]
  patterns: [async subprocess streaming via tokio::process::Command, stderr line-by-line progress emission, PID-based cancel with SIGTERM]

key-files:
  created:
    - src-tauri/src/commands/remote.rs
  modified:
    - src-tauri/Cargo.toml
    - src-tauri/src/state.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/commands/mod.rs

key-decisions:
  - "Store child PID (u32) in RunningOp instead of tokio::process::Child because Child is !Sync"
  - "Pass RunningOp mutex by reference to run_git_remote helper instead of accessing via Tauri State"
  - "Separate refresh_graph helper for DRY graph rebuild across fetch/pull/push"

patterns-established:
  - "Async subprocess streaming: tokio::process::Command with BufReader lines() for stderr"
  - "PID-based cancel: store PID in Mutex<Option<u32>>, send SIGTERM via libc::kill"
  - "Mutual exclusion: check RunningOp before spawning, clear after completion"

requirements-completed: [REMOTE-01, REMOTE-02, REMOTE-03, REMOTE-04]

# Metrics
duration: 4min
completed: 2026-03-12
---

# Phase 13 Plan 01: Remote Operations Backend Summary

**Async git fetch/pull/push commands with tokio subprocess streaming, error taxonomy, and SIGTERM cancel via RunningOp mutex**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T12:34:19Z
- **Completed:** 2026-03-12T12:38:22Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Four Tauri commands (git_fetch, git_pull, git_push, cancel_remote_op) with async subprocess streaming
- Error taxonomy classifying auth failures, non-fast-forward rejections, no-upstream errors, and generic remote errors
- Real-time progress events via remote-progress Tauri event with \r line splitting
- RunningOp mutual exclusion preventing concurrent remote operations with SIGTERM cancel support
- Pull strategy support (ff, ff-only, rebase, or default respecting gitconfig)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add tokio dependency and RunningOp state** - `9e9aaf3` (chore)
2. **Task 2 RED: Failing tests for error taxonomy** - `6dda717` (test)
3. **Task 2 GREEN: Implement remote commands** - `39dc457` (feat)

## Files Created/Modified
- `src-tauri/src/commands/remote.rs` - git_fetch, git_pull, git_push, cancel_remote_op commands with classify_git_error and run_git_remote async helper
- `src-tauri/Cargo.toml` - Added tokio (process, io-util) and libc dependencies
- `src-tauri/src/state.rs` - Added RunningOp state type for PID tracking
- `src-tauri/src/lib.rs` - Registered RunningOp managed state and four new commands
- `src-tauri/src/commands/mod.rs` - Added pub mod remote

## Decisions Made
- Store child PID (u32) in RunningOp instead of tokio::process::Child because Child is !Sync -- same reasoning as RepoState storing PathBuf instead of Repository
- Pass RunningOp inner mutex by reference to run_git_remote helper to avoid needing Tauri State in non-command functions
- Created separate refresh_graph async helper to DRY the graph rebuild pattern across fetch/pull/push

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Backend remote commands ready for frontend integration
- remote-progress event ready for StatusBar component consumption
- RunningOp state ready for toolbar button disable logic
- Error taxonomy ready for status bar error display with actionable hints

## Self-Check: PASSED

All 6 files verified present. All 3 commits verified in git log.

---
*Phase: 13-remote-operations*
*Completed: 2026-03-12*
