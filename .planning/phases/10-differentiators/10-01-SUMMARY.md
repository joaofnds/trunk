---
phase: 10-differentiators
plan: 01
subsystem: ui
tags: [svelte, rust, git-graph, lane-colors, ref-pills]

# Dependency graph
requires:
  - phase: 08-straight-rail-rendering
    provides: "Three-layer SVG rendering with lane color palette"
  - phase: 09-wip-row
    provides: "WIP sentinel row handling in LaneSvg"
provides:
  - "RefLabel.color_index field flowing from Rust backend to TypeScript frontend"
  - "Lane-colored ref pills replacing static type-based colors"
  - "Remote-only ref dimming at 50% opacity"
  - "Horizontal connector line from pill area to commit dot"
affects: [10-differentiators]

# Tech tracking
tech-stack:
  added: []
  patterns: ["inline-style lane coloring via CSS variables", "ref-to-commit color inheritance"]

key-files:
  created: []
  modified:
    - src-tauri/src/git/types.rs
    - src-tauri/src/git/repository.rs
    - src-tauri/src/git/graph.rs
    - src-tauri/src/commands/branches.rs
    - src/lib/types.ts
    - src/components/RefPill.svelte
    - src/components/LaneSvg.svelte

key-decisions:
  - "RefLabel.color_index set from commit color_index during graph output assembly (not during ref_map build)"
  - "Inline styles for lane colors (not Tailwind classes) since color_index is dynamic"
  - "Remote-only detection: RemoteBranch with no sibling LocalBranch or Tag on same commit"

patterns-established:
  - "Lane color inheritance: refs inherit their commit's lane color via color_index"
  - "Inline style for dynamic CSS variable references: var(--lane-N)"

requirements-completed: [DIFF-01]

# Metrics
duration: 4min
completed: 2026-03-09
---

# Phase 10 Plan 01: Lane-Colored Ref Pills Summary

**Lane-colored ref pills with remote dimming and horizontal connector lines linking pills to commit dots**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-09T22:40:18Z
- **Completed:** 2026-03-09T22:44:19Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Added color_index field to RefLabel flowing from Rust backend through IPC to TypeScript frontend
- Replaced static type-based pill colors (green/accent) with dynamic lane-color backgrounds and white text
- Added remote-only ref dimming at 50% opacity
- Added horizontal connector line from SVG left edge to commit dot for commits with refs (except column 0 and WIP)
- Added two new tests: ref_label_color_index and ref_label_no_refs_no_panic

## Task Commits

Each task was committed atomically:

1. **Task 1: Add color_index to RefLabel in Rust and TypeScript** - `41c517a` (feat)
2. **Task 2: Lane-colored RefPill and connector line in LaneSvg** - `f533784` (feat)

## Files Created/Modified
- `src-tauri/src/git/types.rs` - Added color_index: usize field to RefLabel struct
- `src-tauri/src/git/repository.rs` - Initialize color_index: 0 at both RefLabel construction sites
- `src-tauri/src/git/graph.rs` - Set ref color_index from commit's lane color during output assembly; added 2 tests
- `src-tauri/src/commands/branches.rs` - Added color_index: 0 to tag and stash RefLabel construction
- `src/lib/types.ts` - Added color_index: number to RefLabel interface
- `src/components/RefPill.svelte` - Lane-color inline styles, remote-only dimming, HEAD bold
- `src/components/LaneSvg.svelte` - Horizontal connector line between pill area and commit dot

## Decisions Made
- RefLabel.color_index is set from the commit's color_index during graph output assembly (Step 5 in graph.rs), not during ref_map construction, because lane assignment hasn't happened yet during ref_map build
- Used inline styles for lane colors since color_index is dynamic and Tailwind can't generate arbitrary CSS variable classes at build time
- Remote-only detection checks if a RemoteBranch ref has no sibling LocalBranch or Tag on the same commit

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed missing color_index in branches.rs RefLabel constructors**
- **Found during:** Task 1
- **Issue:** Two additional RefLabel construction sites in src-tauri/src/commands/branches.rs (tags and stashes) were not listed in the plan but failed compilation after adding color_index to the struct
- **Fix:** Added color_index: 0 to both RefLabel constructors in branches.rs
- **Files modified:** src-tauri/src/commands/branches.rs
- **Verification:** cargo test --lib passes (52 tests)
- **Committed in:** 41c517a (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix for compilation. No scope creep.

## Issues Encountered
- Pre-existing type error in CommitGraph.svelte (virtual list library type incompatibility) causes `bun run check` to exit with code 1. Verified this error exists on the clean main branch before any changes. Not introduced by this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Lane-colored ref pills are rendering with dynamic colors from the graph algorithm
- Connector lines link the ref pill column to commit dots
- Ready for any remaining Phase 10 differentiator plans

---
*Phase: 10-differentiators*
*Completed: 2026-03-09*
