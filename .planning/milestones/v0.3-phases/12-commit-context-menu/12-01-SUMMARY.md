---
phase: 12-commit-context-menu
plan: 01
subsystem: api
tags: [tauri, git2, git-cli, clipboard, commands]

# Dependency graph
requires:
  - phase: 11-stash-operations
    provides: "stash.rs command pattern (inner fn + outer tauri::command wrapper), graph::walk_commits"
provides:
  - "checkout_commit command (detached HEAD)"
  - "create_tag command (annotated tags)"
  - "cherry_pick command (git CLI)"
  - "revert_commit command (git CLI)"
  - "create_branch from_oid parameter (branch from any commit)"
  - "clipboard-manager plugin for frontend copy actions"
affects: [12-commit-context-menu]

# Tech tracking
tech-stack:
  added: [tauri-plugin-clipboard-manager]
  patterns: [git-cli-subprocess-with-GIT_TERMINAL_PROMPT=0, graph-mutating-command-pattern]

key-files:
  created: [src-tauri/src/commands/commit_actions.rs]
  modified: [src-tauri/src/commands/branches.rs, src-tauri/src/commands/mod.rs, src-tauri/src/lib.rs, src-tauri/Cargo.toml, src-tauri/capabilities/default.json, package.json]

key-decisions:
  - "Duplicated open_repo and is_dirty helpers in commit_actions.rs to avoid circular dependencies"
  - "cherry_pick and revert use git CLI subprocess (not git2) per v0.3 decision for conflict state handling"
  - "create_branch dirty workdir check happens after branch creation but before checkout -- branch exists, HEAD doesn't move"

patterns-established:
  - "Git CLI subprocess pattern: Command::new('git').env('GIT_TERMINAL_PROMPT', '0') for operations requiring conflict awareness"
  - "from_oid optional parameter pattern: Option<&str> for commands that can target specific commits"

requirements-completed: [MENU-03, MENU-04, MENU-05, MENU-06, MENU-07]

# Metrics
duration: 6min
completed: 2026-03-12
---

# Phase 12 Plan 01: Backend Commands Summary

**4 commit action commands (checkout, tag, cherry-pick, revert) with from_oid branch extension and clipboard plugin**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-12T02:41:09Z
- **Completed:** 2026-03-12T02:47:36Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Created commit_actions.rs with checkout_commit, create_tag, cherry_pick, revert_commit (inner + outer wrappers)
- Extended create_branch_inner with from_oid: Option<&str> for branching from any commit
- Installed tauri-plugin-clipboard-manager (Rust + JS) with capability permission
- Registered all 4 new commands in invoke_handler
- All 68 tests pass, cargo build succeeds

## Task Commits

Each task was committed atomically:

1. **Task 1: Create commit_actions.rs with checkout_commit, create_tag, cherry_pick, revert_commit** - `e1a0b42` (feat)
2. **Task 2: Extend create_branch with from_oid + install clipboard plugin + register commands** - `ebee17f` (feat)

## Files Created/Modified
- `src-tauri/src/commands/commit_actions.rs` - 4 new commands: checkout_commit, create_tag, cherry_pick, revert_commit with inner fns + outer tauri wrappers
- `src-tauri/src/commands/branches.rs` - Extended create_branch_inner with from_oid parameter, added 2 new tests
- `src-tauri/src/commands/mod.rs` - Added pub mod commit_actions
- `src-tauri/src/lib.rs` - Registered 4 new commands + clipboard-manager plugin
- `src-tauri/Cargo.toml` - Added tauri-plugin-clipboard-manager dependency
- `src-tauri/capabilities/default.json` - Added clipboard-manager:allow-write-text permission
- `package.json` - Added @tauri-apps/plugin-clipboard-manager

## Decisions Made
- Duplicated open_repo and is_dirty helpers in commit_actions.rs to avoid cross-module dependencies
- cherry_pick and revert use git CLI subprocess (not git2) per v0.3 decision for reliable conflict detection
- create_branch dirty workdir check runs after branch creation but before checkout -- branch exists even if checkout fails

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All backend commands ready for the context menu UI (plan 02) to invoke via safeInvoke
- Clipboard plugin ready for frontend copy SHA/message actions
- create_branch from_oid ready for "Create Branch Here" menu item

---
*Phase: 12-commit-context-menu*
*Completed: 2026-03-12*
