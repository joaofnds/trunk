---
phase: 03-branch-sidebar-checkout
plan: "05"
subsystem: ui
tags: [svelte, css, truncation, virtual-list, commit-graph, scroll]

# Dependency graph
requires:
  - phase: 03-branch-sidebar-checkout
    provides: BranchRow, RemoteGroup, CommitGraph components established; SvelteVirtualList in use
provides:
  - Long remote branch names truncate with ellipsis in the sidebar (no wrapping)
  - CommitGraph scrolls to HEAD commit automatically after branch checkout
affects:
  - Phase 4 (Staging + Commit) — CommitGraph behaviour is now scroll-aware; BranchRow styling baseline established

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CSS flex truncation: overflow:hidden on container + min-width:0 + flex:1 on text span"
    - "SvelteVirtualList programmatic scroll via bind:this + scrolledToHead one-shot guard"

key-files:
  created: []
  modified:
    - src/components/BranchRow.svelte
    - src/components/RemoteGroup.svelte
    - src/components/CommitGraph.svelte

key-decisions:
  - "Wrap text node in <span> rather than adding truncation to flex container directly — container needs display:flex for layout, span gets block truncation context"
  - "overflow:hidden on RemoteGroup indent wrapper acts as defensive guard in case span min-width leaks"
  - "scrolledToHead flag resets per CommitGraph mount — App.svelte {#key graphKey} already ensures full remount on checkout, so no explicit reset needed"

patterns-established:
  - "One-shot $effect: guard with a boolean $state flag so reactive effects fire exactly once per component lifecycle"

requirements-completed: [BRNCH-01, BRNCH-02]

# Metrics
duration: 2min
completed: 2026-03-04
---

# Phase 3 Plan 05: UAT Gap Closure — Branch Name Truncation + Graph Scroll to HEAD

**CSS flex truncation for long remote branch names and one-shot $effect scrolling CommitGraph to HEAD after checkout**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-04T18:25:25Z
- **Completed:** 2026-03-04T18:27:25Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Long remote branch names (e.g. `dependabot/github_actions/actions/...`) now clip with ellipsis at the 220px sidebar boundary — no second-line wrapping
- After checking out any branch, CommitGraph scrolls to position HEAD commit at the top of the visible area using `SvelteVirtualList.scroll({ index, align: 'top' })`
- `scrolledToHead` boolean guard ensures the scroll fires exactly once per CommitGraph mount, preventing reactive re-fires on subsequent commit batch loads

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix branch name truncation in BranchRow and RemoteGroup** - `937e61e` (fix)
2. **Task 2: Scroll commit graph to HEAD after mount** - `21ab519` (feat)

## Files Created/Modified

- `src/components/BranchRow.svelte` - Added `overflow: hidden` to flex container; wrapped text node in `<span>` with `overflow:hidden; white-space:nowrap; text-overflow:ellipsis; min-width:0; flex:1`
- `src/components/RemoteGroup.svelte` - Added `overflow: hidden` to indent wrapper `<div>` as defensive guard
- `src/components/CommitGraph.svelte` - Declared `listRef` and `scrolledToHead` state; added `bind:this={listRef}` to `SvelteVirtualList`; added one-shot `$effect` to scroll to HEAD index after first commit batch loads

## Decisions Made

- Wrapped text in `<span>` rather than applying truncation directly to the flex container: the container must retain `display: flex; align-items: center` for its layout role, so a child `<span>` with `display: block` provides the independent block formatting context required for `text-overflow: ellipsis` to work.
- `overflow: hidden` on the `RemoteGroup` indent wrapper (`padding-left: 12px` div) is a defensive guard: if a flex child's `min-width: auto` ever escapes the span, the wrapper clips it at the sidebar boundary.
- `scrolledToHead` flag is not explicitly reset on unmount — `{#key graphKey}` in App.svelte already causes a full CommitGraph remount on every checkout, so the fresh component instance starts with `scrolledToHead = false` automatically.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The pre-existing warning in `LaneSvg.svelte` (`state_referenced_locally`) was present before this plan and is out of scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 UAT gaps (test 6 — branch name wrapping; test 8 — graph not scrolling to HEAD) are now closed.
- All phase 3 success criteria met.
- Phase 4 (Staging Panel + Commit) can begin: file diff, staging area, commit form.

---
*Phase: 03-branch-sidebar-checkout*
*Completed: 2026-03-04*

## Self-Check: PASSED

- src/components/BranchRow.svelte: EXISTS, contains overflow:hidden
- src/components/RemoteGroup.svelte: EXISTS, contains overflow:hidden
- src/components/CommitGraph.svelte: EXISTS, contains bind:this={listRef} and scrolledToHead
- .planning/phases/03-branch-sidebar-checkout/03-05-SUMMARY.md: EXISTS
- Commit 937e61e (Task 1): FOUND
- Commit 21ab519 (Task 2): FOUND
