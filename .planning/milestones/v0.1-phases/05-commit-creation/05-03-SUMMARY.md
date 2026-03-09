---
phase: 05-commit-creation
plan: 03
subsystem: ui
tags: [svelte, tauri, git2, commit-graph, event-listener]

requires:
  - phase: 05-01
    provides: create_commit, amend_commit, get_head_commit_message Tauri commands
  - phase: 05-02
    provides: CommitForm Svelte component and StagingPanel layout

provides:
  - commit commands registered in lib.rs generate_handler!
  - repo-changed listener in App.svelte bumping graphKey for graph refresh
  - end-to-end commit and amend flows verified

affects: [future phases that modify RepoState or CommitCache invalidation]

tech-stack:
  added: []
  patterns:
    - "Cache repopulate before emit: after mutating git state, refresh CommitCache inline before emitting repo-changed so dependent consumers never see a stale/missing cache entry"
    - "repo-changed listener in App.svelte: single top-level listener bumps graphKey to remount CommitGraph on any repo mutation"

key-files:
  created: []
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/src/commands/commit.rs
    - src/App.svelte

key-decisions:
  - "Cache repopulate-before-emit: create_commit and amend_commit call refresh_commit_cache inside spawn_blocking after writing to git, then insert the result before emitting repo-changed — prevents CommitGraph remount from racing a cleared cache"
  - "refresh_commit_cache helper: extracted as standalone fn in commit.rs, mirrors open_repo walk_commits pattern"

patterns-established:
  - "Mutate → repopulate cache → emit: any command that invalidates CommitCache must also repopulate it in the same spawn_blocking closure before emitting repo-changed"

requirements-completed: [COMIT-01, COMIT-02, COMIT-03]

duration: ~30min
completed: 2026-03-07
---

# Phase 05 Plan 03: Wire Commit Commands and Verify End-to-End Summary

**Commit loop fully wired: create/amend commands registered in generate_handler!, App.svelte listens to repo-changed to refresh the graph, with a cache-repopulate fix ensuring CommitGraph never races a cleared CommitCache.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-03-07
- **Completed:** 2026-03-07
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Registered `create_commit`, `amend_commit`, and `get_head_commit_message` in `lib.rs generate_handler!`
- Added `$effect` block in `App.svelte` listening to `repo-changed` events and calling `handleRefresh()` to bump `graphKey` and remount `CommitGraph`
- Fixed bug where `CommitCache` was cleared but not repopulated before emitting `repo-changed`, causing "Repository not open" error banner after every commit
- All four end-to-end flows verified: empty validation, create commit, amend commit, commit with body

## Task Commits

1. **Task 1: Register commit commands and add graph refresh listener** - `1216f45` (feat)
2. **Task 2 bug fix: Repopulate CommitCache after commit** - `c62f432` (fix)
3. **Task 2: Human verification — approved** (no code commit needed)

## Files Created/Modified

- `src-tauri/src/lib.rs` - Added three commit commands to `generate_handler![]`
- `src-tauri/src/commands/commit.rs` - Added `refresh_commit_cache` helper; `create_commit` and `amend_commit` now repopulate cache before emitting `repo-changed`
- `src/App.svelte` - Added `listen` import and `$effect` block for `repo-changed` → `handleRefresh()`

## Decisions Made

- **Cache repopulate-before-emit pattern:** `create_commit` and `amend_commit` call `refresh_commit_cache` inside the same `spawn_blocking` closure immediately after writing to git, insert the result into `CommitCache`, then emit `repo-changed`. This ensures `CommitGraph`'s first `get_commit_graph` call after remount always finds a populated cache.
- **`refresh_commit_cache` as standalone helper:** Mirrors the `open_repo` walk pattern; keeps the Tauri command bodies clean and reusable for future commands that mutate history.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] CommitCache cleared but not repopulated before repo-changed emission**
- **Found during:** Task 2 (human verification)
- **Issue:** `create_commit` and `amend_commit` called `cache.remove(&path)` then immediately emitted `repo-changed`. App.svelte received the event, bumped `graphKey`, and `CommitGraph` remounted and called `get_commit_graph` — which reads exclusively from `CommitCache`. With the entry deleted and not yet repopulated, it returned `TrunkError { code: "repo_not_open" }`, surfaced in the UI as "repository not open" error banner replacing the graph.
- **Fix:** Added `refresh_commit_cache` fn that re-walks all commits via `graph::walk_commits`. Both commands now call it inside `spawn_blocking` after the write, then `cache.insert` the result before emitting.
- **Files modified:** `src-tauri/src/commands/commit.rs`
- **Verification:** All 31 Rust tests pass; human verification confirmed graph updates correctly after commit and amend.
- **Committed in:** `c62f432`

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug)
**Impact on plan:** Critical correctness fix. Without it the primary user-visible outcome (graph refresh after commit) was broken. No scope creep.

## Issues Encountered

The "repository not open" error was not a logic error in the event plumbing but a missing cache repopulation step — `get_commit_graph` is cache-only and has no fallback to re-walk git directly. The fix aligns commit mutations with the `open_repo` pattern.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 5 commit-creation is fully complete. All three requirements (COMIT-01, COMIT-02, COMIT-03) verified end-to-end.
- The cache-repopulate pattern is now established for any future command that mutates git history.
- No blockers for subsequent phases.

---
*Phase: 05-commit-creation*
*Completed: 2026-03-07*
