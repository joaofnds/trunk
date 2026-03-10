---
status: diagnosed
phase: 10-differentiators
source: [10-01-SUMMARY.md, 10-02-SUMMARY.md, 10-03-SUMMARY.md]
started: 2026-03-09T14:00:00Z
updated: 2026-03-09T14:30:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Lane-Colored Ref Pills
expected: Branch and tag pills next to commits use the lane color of their commit (not static green/accent). Each pill background matches the colored lane the commit sits in, with white text.
result: pass

### 2. Remote-Only Ref Dimming
expected: Remote branches that have no corresponding local branch appear dimmed at 50% opacity compared to local branches or tags.
result: issue
reported: "pass, but the line that connected to them should also have the color dimmed, but it currently has the same undimmed color as the branch"
severity: minor

### 3. Connector Line from Ref Pills to Commit Dot
expected: Commits that have ref pills show a horizontal line connecting from the pill area to the commit dot in the graph column. WIP rows and column-0 commits without refs should not have this line.
result: issue
reported: "the line is overshooting - continuing to the end of the pane instead of stopping at the right of the pill. Also the overflow count is hard to read against the line - make it a small pill to the right of the branch/tag pill"
severity: major

### 4. WIP Dotted Line Connects to HEAD
expected: The WIP row's dotted line extends downward and visually connects to the HEAD commit dot below it. The line should not be clipped or cut off.
result: issue
reported: "when the HEAD is in the hover state, the lighter background stays on top of the dotted line, making it seem like the line is cut short"
severity: minor

### 5. Six-Column Commit Row Layout
expected: Each commit row displays 6 columns: branch/tag refs, graph (SVG lanes), commit message, author name, date (relative like "2d", "3mo"), and short SHA.
result: pass

### 6. Fixed Header Row
expected: A fixed header row with column labels (Branch/Tag, Graph, Message, Author, Date, SHA) appears above the scrollable commit list and stays visible while scrolling.
result: issue
reported: "we're missing a context menu when right clicking on the header row. The context menu should allow us to toggle the visibility of each section."
severity: major

### 7. Drag-to-Resize Columns with Visible Handles
expected: Column dividers are visible at all times as subtle vertical lines. Hovering highlights them. Dragging resizes the columns. The message column flexes to fill remaining space. Graph column has a minimum width that prevents lane clipping.
result: issue
reported: "this is kinda working. The divider should ALWAYS be visible, and they should have a small padding so they're not rubbing against the text."
severity: minor

### 8. Column Width Persistence
expected: After resizing columns, close and reopen the app. The column widths are restored to the sizes you set, not the defaults.
result: pass

## Summary

total: 8
passed: 3
issues: 5
pending: 0
skipped: 0

## Gaps

- truth: "Connector line for remote-only refs should also be dimmed at 50% opacity to match the dimmed pill"
  status: failed
  reason: "User reported: pass, but the line that connected to them should also have the color dimmed, but it currently has the same undimmed color as the branch"
  severity: minor
  test: 2
  root_cause: "Connector line div in CommitRow.svelte (lines 38-41) has no opacity logic. Remote-only dimming is computed entirely inside RefPill.svelte via isRemoteOnly() and never exposed to the parent. The connector line and RefPill are sibling DOM elements with no shared state."
  artifacts:
    - path: "src/components/CommitRow.svelte"
      issue: "Connector line div has no opacity property and no ref-type awareness"
    - path: "src/components/RefPill.svelte"
      issue: "isRemoteOnly() result is private, never exposed to parent"
  missing:
    - "Add allRemoteOnly check in CommitRow using commit.refs array, apply opacity: 0.5 to connector line div when true"
  debug_session: ".planning/debug/connector-line-not-dimmed.md"

- truth: "Connector line stops at the right edge of the last pill; overflow count rendered as a small pill"
  status: failed
  reason: "User reported: the line is overshooting - continuing to the end of the pane instead of stopping at the right of the pill. Also the overflow count is hard to read against the line - make it a small pill to the right of the branch/tag pill"
  severity: major
  test: 3
  root_cause: "Connector line starts at left:0 with width spanning full columnWidths.ref (120px) plus graph offset. Line covers entire ref column regardless of actual pill content width. Overflow count (+N) is a plain <span> with only text styling -- no background, border-radius, or padding."
  artifacts:
    - path: "src/components/CommitRow.svelte"
      issue: "Connector line left:0 and width uses full columnWidths.ref, overshooting past pills"
    - path: "src/components/RefPill.svelte"
      issue: "Overflow count span has zero pill-like CSS (no bg, no rounded, no padding)"
  missing:
    - "Measure actual pill container width (bind:clientWidth), set connector left to start after pills"
    - "Style overflow count as small pill with rounded-full, semi-transparent background, padding"
  debug_session: ".planning/debug/connector-line-overshoot.md"

- truth: "WIP dotted line remains visible when HEAD row is hovered"
  status: failed
  reason: "User reported: when the HEAD is in the hover state, the lighter background stays on top of the dotted line, making it seem like the line is cut short"
  severity: minor
  test: 4
  root_cause: "WIP dotted line overflows 13px below its SVG into HEAD row's space. HEAD row has position:relative + opaque hover background (#161b22) which paints at CSS paint order step 8 (positioned elements), above the overflowing SVG at step 5 (non-positioned in-flow content)."
  artifacts:
    - path: "src/components/CommitRow.svelte"
      issue: "position:relative + opaque hover bg covers SVG overflow from WIP row above"
    - path: "src/components/LaneSvg.svelte"
      issue: "WIP dotted line draws to y2=rowHeight+cy (39px) but SVG is only 26px tall"
  missing:
    - "Give graph column SVG a higher z-index so WIP overflow paints above HEAD hover background"
  debug_session: ".planning/debug/wip-line-hover-coverage.md"

- truth: "Right-clicking header row shows context menu to toggle column visibility"
  status: failed
  reason: "User reported: we're missing a context menu when right clicking on the header row. The context menu should allow us to toggle the visibility of each section."
  severity: major
  test: 6
  root_cause: "Feature entirely unimplemented. No column visibility state in store, no oncontextmenu handler on header, no context menu component exists, both header and CommitRow render all 6 columns unconditionally."
  artifacts:
    - path: "src/lib/store.ts"
      issue: "No ColumnVisibility interface, getter, or setter"
    - path: "src/components/CommitGraph.svelte"
      issue: "Header div has no oncontextmenu handler, no context menu component"
    - path: "src/components/CommitRow.svelte"
      issue: "All 6 columns rendered unconditionally with no visibility checks"
  missing:
    - "Add ColumnVisibility record to store (follow ColumnWidths pattern)"
    - "Add oncontextmenu handler to header div in CommitGraph"
    - "Create context menu dropdown with checkboxes per column"
    - "Gate each column in header and CommitRow with {#if columnVisibility.xxx}"
  debug_session: ".planning/debug/header-context-menu-missing.md"

- truth: "Column dividers are always visible with padding so text doesn't rub against them"
  status: failed
  reason: "User reported: this is kinda working. The divider should ALWAYS be visible, and they should have a small padding so they're not rubbing against the text."
  severity: minor
  test: 7
  root_cause: "Commit b53444c only added visible divider styling to .col-resize-handle in the header row (CommitGraph.svelte). CommitRow.svelte has zero divider/border styling on its column cells. Column cells also have no horizontal padding -- only the outer row wrapper has px-2."
  artifacts:
    - path: "src/components/CommitRow.svelte"
      issue: "No border-right on column cells, no horizontal padding on text-bearing cells"
    - path: "src/components/CommitGraph.svelte"
      issue: "Header dividers work but header column padding is inconsistent"
  missing:
    - "Add border-right: 1px solid var(--color-border) to each column cell in CommitRow except last"
    - "Add horizontal padding (px-1) to text-bearing column cells"
  debug_session: ".planning/debug/column-dividers-visibility.md"
