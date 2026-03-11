---
phase: 11-stash-operations
plan: "03"
subsystem: ui
tags: [svelte, tauri, stash, context-menu, sidebar]

# Dependency graph
requires:
  - phase: 11-stash-operations/11-01
    provides: stash_save/stash_pop/stash_apply/stash_drop Tauri commands + StashEntry type (Rust)
  - phase: 11-stash-operations/11-02
    provides: StashEntry TypeScript interface in src/lib/types.ts
provides:
  - Stash section in BranchSidebar always visible (not gated on stash count)
  - '+' button in stash section header toggles inline create form
  - Inline form with optional name input and Stash button; submitting calls stash_save
  - nothing_to_stash error displays inline in the form (not a popup)
  - StashEntry-aware list: each entry shows short_name (stash@{N}) + truncated name
  - Per-entry right-click context menu with Pop, Apply, Drop actions
  - Drop requires native confirmation dialog via ask() before executing
  - Pop/apply/drop errors displayed inline below the failing entry
  - After any mutation, loadRefs() is called to refresh the stash list
  - RefsResponse.stashes updated from RefLabel[] to StashEntry[] in types.ts
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reuse BranchSection showCreateButton/oncreate props for stash section '+' button"
    - "stashEntryErrors keyed by stash index (Record<number, string | null>) for per-entry error display"
    - "Dynamic import of @tauri-apps/api/menu and @tauri-apps/plugin-dialog in async handlers to avoid top-level import overhead"

key-files:
  created: []
  modified:
    - src/components/BranchSidebar.svelte
    - src/lib/types.ts

key-decisions:
  - "Reuse BranchSection showCreateButton/oncreate props rather than adding a new header slot — zero changes to BranchSection.svelte"
  - "RefsResponse.stashes type corrected from RefLabel[] to StashEntry[] — was not updated in plan 11-02 despite StashEntry being added to types.ts"

patterns-established:
  - "Per-entry error state: Record<number, string|null> keyed by stash index for independent inline errors per stash row"

requirements-completed:
  - STASH-01
  - STASH-03
  - STASH-04
  - STASH-05
  - STASH-06

# Metrics
duration: 2min
completed: 2026-03-11
---

# Phase 11 Plan 03: Stash Sidebar UI Summary

**Stash section in BranchSidebar upgraded with always-visible '+' create form (optional name input, nothing_to_stash inline error) and per-entry right-click context menu (Pop/Apply/Drop) with native confirmation on drop and inline error display**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-11T03:04:41Z
- **Completed:** 2026-03-11T03:06:22Z
- **Tasks:** 1 auto + 1 checkpoint (auto-approved)
- **Files modified:** 2

## Accomplishments
- StashSection is always visible in sidebar (removed `{#if stash count > 0}` guard) so '+' button is always accessible
- Inline create form with optional stash name; nothing_to_stash backend error mapped to user-friendly inline message
- Per-entry right-click shows native Tauri context menu with Pop, Apply, Drop; Drop requires native OS confirmation dialog
- Fixed RefsResponse.stashes type from RefLabel[] to StashEntry[] (was missed in plan 11-02)

## Task Commits

Each task was committed atomically:

1. **Task 1: Upgrade stash section with create form, per-entry context menu, and StashEntry types** - `be2e8e0` (feat)

**Plan metadata:** (pending final docs commit)

## Files Created/Modified
- `src/components/BranchSidebar.svelte` - Stash form state, action handlers (save/pop/apply/drop), upgraded stash section markup with create form and per-entry context menu, scoped CSS
- `src/lib/types.ts` - RefsResponse.stashes changed from RefLabel[] to StashEntry[]

## Decisions Made
- Reused existing `showCreateButton`/`oncreate` props on BranchSection rather than adding a new `header-action` slot — zero changes to BranchSection.svelte
- RefsResponse.stashes type was still `RefLabel[]` (plan 11-02 added StashEntry to types.ts but did not update RefsResponse); corrected inline as Rule 1 (bug fix)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated RefsResponse.stashes from RefLabel[] to StashEntry[]**
- **Found during:** Task 1
- **Issue:** Plan 11-02 added StashEntry interface to types.ts but did not update RefsResponse.stashes (still RefLabel[]). Using StashEntry-specific fields (index, short_name) on RefLabel[] would be a type error.
- **Fix:** Changed `stashes: RefLabel[]` to `stashes: StashEntry[]` in RefsResponse in src/lib/types.ts
- **Files modified:** src/lib/types.ts
- **Verification:** TypeScript compiles with no errors
- **Committed in:** be2e8e0 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - type bug)
**Impact on plan:** Necessary for TypeScript correctness. No scope creep.

## Issues Encountered
- BranchSection did not have a `header-action` slot (as the plan anticipated). Used the existing `showCreateButton`/`oncreate` props instead — cleaner solution requiring no BranchSection changes.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All STASH requirements (01, 03, 04, 05, 06) are now satisfied via the sidebar UI
- STASH-02 (graph rendering) and STASH-07 (graph context menu) were satisfied in plan 11-02
- Phase 11 complete; ready for Phase 12

## Self-Check: PASSED

All files and commits verified present.

---
*Phase: 11-stash-operations*
*Completed: 2026-03-11*
