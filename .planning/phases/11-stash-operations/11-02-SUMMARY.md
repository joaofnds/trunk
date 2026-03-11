---
phase: 11-stash-operations
plan: "02"
subsystem: ui
tags: [svelte, graph, stash, tauri, ipc, context-menu]

# Dependency graph
requires:
  - phase: 11-stash-operations/11-01
    provides: Rust stash_pop/stash_apply/stash_drop/list_stashes Tauri commands + StashEntry DTO

provides:
  - StashEntry TypeScript interface exported from src/lib/types.ts
  - Stash rows injected as synthetic GraphCommit items in CommitGraph.svelte with __stash_N__ OID sentinel
  - makeStashItem function positioning stash rows at their parent commit in a dedicated rightmost column
  - Hollow square SVG rect in LaneSvg.svelte for __stash_N__ OID pattern (using MERGE_STROKE weight)
  - Right-click context menu on stash rows with Pop, Apply, Drop actions
  - Drop confirmation dialog using @tauri-apps/plugin-dialog ask()
  - Stash list loaded via list_stashes IPC on initial load and after every refresh
  - Dismissable stash error display for pop/apply/drop operation failures

affects:
  - 11-03-stash-sidebar (uses same stash IPC commands + StashEntry type)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "__stash_N__ OID sentinel pattern: stash rows use synthetic oids to distinguish from real commits in LaneSvg dot rendering"
    - "stashColumn = maxColumns: stash column is always one beyond active branch lanes, using $derived(maxColumns)"
    - "$derived(() => { ... })() IIFE pattern for complex multi-step derived computation in Svelte 5"

key-files:
  created: []
  modified:
    - src/lib/types.ts
    - src/components/CommitGraph.svelte
    - src/components/LaneSvg.svelte

key-decisions:
  - "Use IIFE $derived(() => { ... })() for displayItems — enables imperative splice logic while remaining reactive"
  - "stashColumn = maxColumns (not maxColumns + offset) — stash column is simply one beyond active lanes as returned from backend"
  - "is_branch_tip: true on stash GraphCommit — reuses existing LaneSvg rail logic to suppress incoming rail from above"
  - "Stash pop/apply/drop handlers call refresh() after success — ensures graph reflects post-operation state immediately"
  - "Stash error shown inline with Dismiss button rather than modal — secondary to sidebar errors (11-03)"

patterns-established:
  - "Sentinel OID pattern: use __X__ prefix OIDs to differentiate synthetic rows in LaneSvg conditional rendering"
  - "Context menu on graph rows: wrap CommitRow in div with oncontextmenu, parse index from sentinel OID"

requirements-completed:
  - STASH-02
  - STASH-07

# Metrics
duration: 3min
completed: 2026-03-11
---

# Phase 11 Plan 02: Stash Graph Rendering Summary

**Stash entries rendered as hollow-square synthetic rows in the commit graph rightmost column with right-click Pop/Apply/Drop context menu and native Drop confirmation dialog**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-11T02:59:41Z
- **Completed:** 2026-03-11T03:02:52Z
- **Tasks:** 2 auto + 1 checkpoint (auto-approved)
- **Files modified:** 3

## Accomplishments
- Stash rows appear as synthetic GraphCommit entries with `__stash_N__` OID sentinels, positioned immediately before their parent commit in a dedicated rightmost column (`stashColumn = maxColumns`)
- LaneSvg renders hollow square SVG `<rect>` for any commit with `oid.startsWith('__stash_')`, using the same stroke weight as merge commit hollow circles
- Right-click on stash row shows native context menu with Pop, Apply, Drop; Drop shows native OS confirmation dialog before executing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add StashEntry to types.ts and stash row injection in CommitGraph** - `6ed3293` (feat)
2. **Task 2: Hollow square dot in LaneSvg and right-click context menu on stash rows** - `ef630de` (feat)

**Plan metadata:** (pending final docs commit)

## Files Created/Modified
- `src/lib/types.ts` - Added StashEntry interface (index, name, short_name, parent_oid)
- `src/components/CommitGraph.svelte` - makeStashItem, stashColumn, displayItems with stash injection, loadStashes(), stash context menu handlers, stash error display
- `src/components/LaneSvg.svelte` - Hollow square rect for __stash_N__ OIDs in dot layer

## Decisions Made
- Used IIFE `$derived(() => { ... })()` pattern for displayItems to allow imperative `splice` logic while keeping Svelte 5 reactivity
- `stashColumn = maxColumns` — the stash column is one beyond active branch lanes, matching the backend's `max_columns` value
- `is_branch_tip: true` on stash GraphCommit reuses LaneSvg's existing branch-tip logic to suppress the incoming rail from above
- Stash pop/apply/drop handlers call `refresh()` after success so the graph immediately reflects the operation result
- Stash error shown inline (dismissable) as a secondary indicator — the sidebar (11-03) owns the primary error surface

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Stash graph rendering complete (STASH-02 and STASH-07 satisfied)
- Plan 11-03 (stash sidebar) can proceed: StashEntry type and all stash IPC commands (list_stashes, stash_pop, stash_apply, stash_drop) are wired up
- The `__stash_N__` sentinel OID pattern is established and documented for 11-03's reference

---
*Phase: 11-stash-operations*
*Completed: 2026-03-11*
