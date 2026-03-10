---
phase: 09-wip-row-visual-polish
plan: 01
subsystem: ui
tags: [svelte, svg, virtual-list, commit-graph, wip]

# Dependency graph
requires:
  - phase: 08-straight-rail-rendering
    provides: Three-layer SVG rendering pipeline in LaneSvg.svelte
provides:
  - Conditional dot rendering (hollow merge, dashed WIP, filled regular) in LaneSvg
  - WIP row as synthetic GraphCommit inside virtual list with dashed connector
  - WIP-aware click routing in CommitRow via __wip__ sentinel oid
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sentinel oid '__wip__' for synthetic virtual list items"
    - "Conditional SVG dot styles via if/else chain on commit properties"
    - "displayItems derived value wrapping commits with optional WIP prepend"

key-files:
  created: []
  modified:
    - src/components/LaneSvg.svelte
    - src/components/CommitGraph.svelte
    - src/components/CommitRow.svelte

key-decisions:
  - "WIP synthetic item uses sentinel oid '__wip__' rather than adding is_wip boolean to GraphCommit type"
  - "Hollow merge dot uses fill=var(--color-bg) to hide rail line through center, accepting minor hover mismatch"
  - "Unused .wip-row CSS removed since WIP now renders through CommitRow pipeline"

patterns-established:
  - "Sentinel oid pattern: Use '__wip__' to identify synthetic items in GraphCommit array"
  - "displayItems pattern: Derived value wrapping backend data with frontend-only synthetic items"

requirements-completed: [VIS-01, VIS-02, VIS-03]

# Metrics
duration: 2min
completed: 2026-03-09
---

# Phase 9 Plan 1: WIP Row Visual Polish Summary

**Merge commits render as hollow circles, WIP row integrated into virtual list with dashed connector line to HEAD**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-09T21:34:33Z
- **Completed:** 2026-03-09T21:36:41Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Merge commits display as hollow circles (background-filled ring with lane-colored stroke), visually distinct from regular filled dots
- WIP row moved inside virtual list as first item via synthetic GraphCommit with '__wip__' sentinel oid
- WIP dot and connector rendered as dashed SVG elements, matching the "uncommitted" visual language
- WIP click correctly routes to onWipClick callback instead of oncommitselect
- Eliminated 6 unused CSS selector warnings by removing obsolete .wip-* styles

## Task Commits

Each task was committed atomically:

1. **Task 1: Merge commit hollow dots and WIP dashed rendering in LaneSvg** - `306c2f6` (feat)
2. **Task 2: WIP row inside virtual list with synthetic GraphCommit** - `e5dc8d6` (feat)
3. **Task 3: Visual verification** - auto-approved (no commit)

## Files Created/Modified
- `src/components/LaneSvg.svelte` - Conditional 3-way dot rendering (WIP dashed, merge hollow, regular filled) and WIP Layer 1 override with dashed vertical line
- `src/components/CommitGraph.svelte` - makeWipItem helper, displayItems derived value, WIP click routing in renderItem snippet, removed old WIP div and unused CSS
- `src/components/CommitRow.svelte` - WIP-specific text styling (italic, muted color, no short_oid)

## Decisions Made
- Used sentinel oid '__wip__' to identify WIP items rather than extending the TypeScript GraphCommit type with an is_wip boolean -- keeps the type aligned with the Rust backend struct
- Merge dot uses `fill="var(--color-bg)"` rather than `fill="transparent"` to hide the rail line passing through the circle center, accepting a minor hover background mismatch as the lesser visual artifact
- Removed all .wip-row CSS classes since WIP now renders through the standard CommitRow pipeline

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three visual requirements (VIS-01, VIS-02, VIS-03) are satisfied
- No backend changes were needed -- all changes are frontend-only
- The pre-existing SvelteVirtualList type mismatch (bind:this type) remains from Phase 8 and is unrelated to this plan

## Self-Check: PASSED

- All 3 modified source files exist
- Both task commits verified (306c2f6, e5dc8d6)
- SUMMARY.md created

---
*Phase: 09-wip-row-visual-polish*
*Completed: 2026-03-09*
