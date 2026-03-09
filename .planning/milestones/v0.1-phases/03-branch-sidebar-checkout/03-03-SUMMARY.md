---
phase: 03-branch-sidebar-checkout
plan: "03"
subsystem: ui

tags: [tauri, svelte5, rust, git2, branch, checkout, layout]

# Dependency graph
requires:
  - phase: 03-branch-sidebar-checkout/03-01
    provides: list_refs, checkout_branch, create_branch Tauri commands
  - phase: 03-branch-sidebar-checkout/03-02
    provides: BranchSidebar Svelte component
provides:
  - Branch commands registered in Tauri generate_handler![]
  - 2-pane layout (BranchSidebar | CommitGraph) wired in App.svelte
  - Full Phase 3 feature set verified end-to-end by human visual verification
affects: [04-staging-commit, future-phases]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "{#key graphKey} pattern for forcing CommitGraph remount after checkout/create"
    - "graphKey reset to 0 on repo close to avoid stale key state across sessions"

key-files:
  created: []
  modified:
    - src-tauri/src/lib.rs
    - src/App.svelte

key-decisions:
  - "flex-1 wrapper required around CommitGraph inside flex main to prevent zero-width collapse in 2-pane layout"
  - "checkout_branch must call checkout_tree+set_head (not set_head+checkout_head) to update working tree correctly"

patterns-established:
  - "2-pane layout pattern: BranchSidebar (fixed 220px) | CommitGraph (flex-1) inside flex main"
  - "graphKey counter drives {#key} remount of CommitGraph after sidebar operations that affect HEAD"

requirements-completed: [BRNCH-01, BRNCH-02, BRNCH-03, BRNCH-04]

# Metrics
duration: ~30min
completed: 2026-03-04
---

# Phase 3 Plan 03: Branch Sidebar + Checkout — Integration & Verification Summary

**2-pane branch sidebar layout wired into App.svelte with all three branch commands registered in Tauri, verified end-to-end via human visual inspection of 10 checkpoints**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-03-04
- **Completed:** 2026-03-04
- **Tasks:** 2 (+ 2 bug fixes during verification)
- **Files modified:** 2

## Accomplishments

- Registered `list_refs`, `checkout_branch`, and `create_branch` in `generate_handler![]` in lib.rs
- Updated App.svelte to 2-pane layout: BranchSidebar (left) beside CommitGraph (right), with `{#key graphKey}` remount pattern wiring branch operations to graph refresh
- All 10 visual verification checkpoints passed: sidebar layout, local/remote/tag sections, section counts, search filter, clean-tree checkout, dirty-tree error banner, error banner dismissal, and create-branch flow

## Task Commits

Each task was committed atomically:

1. **Task 1: Register branch commands and update App.svelte layout** - `99d3921` (feat)
2. **Fix: Restore commit graph rendering in 2-pane layout** - `e7b4b23` (fix)
3. **Fix: Update working tree on branch checkout** - `c15516a` (fix)
4. **Task 2: Visual verification** - Approved by user (no code commit)

## Files Created/Modified

- `src-tauri/src/lib.rs` - Added `list_refs`, `checkout_branch`, `create_branch` to `generate_handler![]`
- `src/App.svelte` - Added BranchSidebar import, `graphKey` counter, `handleRefresh`, 2-pane `<main>` layout with `{#key graphKey}` CommitGraph remount

## Decisions Made

- `{#key graphKey}` forces CommitGraph remount (not just re-render) after checkout and branch create — ensures the graph reloads from scratch rather than patching stale state
- `graphKey` reset to `0` on `handleClose` so re-opening a different repo starts from a clean counter

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Commit graph collapsed to zero width in 2-pane layout**
- **Found during:** Task 1 verification (visual checkpoint 1 — sidebar visible)
- **Issue:** CommitGraph rendered inside a flex container without `flex-1`, causing it to collapse to zero width and become invisible
- **Fix:** Wrapped CommitGraph in a `<div class="flex-1 overflow-hidden">` so it fills remaining horizontal space
- **Files modified:** `src/App.svelte`
- **Verification:** Graph visible side-by-side with sidebar in tauri dev
- **Committed in:** `e7b4b23`

**2. [Rule 1 - Bug] `checkout_branch` left working tree dirty after switch**
- **Found during:** Task 2 visual verification (checkpoint 7 — clean-tree checkout)
- **Issue:** Implementation used `set_head` + `checkout_head` instead of `checkout_tree` + `set_head`; the working tree was not updated, leaving files from the previous branch on disk
- **Fix:** Replaced `checkout_head` with `repo.checkout_tree(&obj, Some(&mut opts))` followed by `repo.set_head(refname)` — the correct git2 pattern for updating both index and working tree
- **Files modified:** `src-tauri/src/commands/branches.rs`
- **Verification:** Checkout now updates the working tree; `git status` clean after switching branches
- **Committed in:** `c15516a`

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs)
**Impact on plan:** Both fixes essential for correctness. No scope creep.

## Issues Encountered

None beyond the two bugs documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 complete: branch sidebar with list, search, checkout, create, and dirty-tree error banner all working end-to-end
- Phase 4 (Staging + Commit) can now import the same `{#key graphKey}` / `handleRefresh` pattern to trigger graph refresh after a commit
- No blockers

---
*Phase: 03-branch-sidebar-checkout*
*Completed: 2026-03-04*
