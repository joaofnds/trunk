---
status: resolved
trigger: "Connector line and WIP dotted line not working after 6-column layout change"
created: 2026-03-09T23:00:00Z
updated: 2026-03-10T00:00:00Z
---

## Current Focus

hypothesis: Both issues stem from the ref column being separated from the graph column in the 6-column layout, while the connector/WIP line logic in LaneSvg still assumes it can draw from x=0 to the commit dot within a single SVG
test: Analyze the layout structure and SVG coordinate system
expecting: The SVG in the graph column cannot reach left into the ref column
next_action: Document root cause analysis

## Symptoms

expected: (1) Horizontal connector lines visible from ref pill area to commit dot. (2) WIP dotted vertical line connects to HEAD commit in next row.
actual: (1) Connector lines not rendering at all. (2) WIP dotted line not connecting to HEAD commit.
errors: No console errors reported - silent rendering failure
reproduction: Open any repo with branch/tag refs and WIP changes
started: After Phase 10-02 (6-column layout change)

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-09T23:00:00Z
  checked: CommitRow.svelte layout structure
  found: Column 1 (ref pills) and Column 2 (graph/LaneSvg) are separate sibling divs in a flex row. The ref column has width=columnWidths.ref (default 120px). The graph column has width=columnWidths.graph (default 120px).
  implication: LaneSvg's SVG element lives inside the graph column div, which is a SEPARATE element from the ref column. The SVG coordinate system starts at x=0 within the graph column, NOT at the left edge of the ref column.

- timestamp: 2026-03-09T23:01:00Z
  checked: LaneSvg.svelte connector line logic (lines 82-92)
  found: The connector line condition is `commit.refs.length > 0 && commit.oid !== '__wip__' && cx(commit.column) > laneWidth`. It draws from x1=0 to x2=cx(commit.column). For a commit in column 0, cx(0) = laneWidth/2 = 6, which is NOT > laneWidth (12), so the condition is false and the line never renders for column-0 commits. For commits in column 1+, the line draws from x=0 to the commit dot, but this is still within the graph SVG - it does NOT extend left into the ref pill column.
  implication: The connector line was designed when the ref pills were inside the same parent as the graph SVG (old 3-column layout). Now that they are in separate columns, drawing from x=0 in the graph SVG only starts at the left edge of the graph column, not at the ref pills.

- timestamp: 2026-03-09T23:02:00Z
  checked: LaneSvg.svelte WIP dotted line logic (lines 59-66)
  found: The WIP dotted line draws from y1=cy+4 to y2=rowHeight+cy. cy=rowHeight/2=13. So y1=17, y2=39. The SVG height is rowHeight=26. The line extends 13px below the SVG bottom (from y=26 to y=39) using overflow:visible.
  implication: In the old layout, overflow:visible would allow the line to visually extend into the next row's graph area. BUT in the new layout, the graph column div has `overflow-hidden` class (CommitRow.svelte line 42). This clips the SVG overflow, preventing the WIP dotted line from extending into the next row.

- timestamp: 2026-03-09T23:03:00Z
  checked: CommitRow.svelte line 42 graph column div
  found: `<div class="flex items-center flex-shrink-0 overflow-hidden" style="width: {columnWidths.graph}px; ...">`  The `overflow-hidden` class on the graph column div clips any SVG content that extends beyond the div boundaries.
  implication: This is the direct cause of WIP dotted line not connecting to HEAD. The SVG uses overflow:visible but its parent div clips overflow.

## Resolution

root_cause: Two distinct but related issues caused by the 6-column layout restructuring (10-02):

**Issue 1 - Connector line not rendering:**
The connector line in LaneSvg.svelte (line 82-92) draws a horizontal line from x=0 to cx(commit.column) within the graph SVG. This was designed when ref pills and graph were in the same visual container. After the 6-column split, the ref pills are in Column 1 (a separate div with width=120px) and the graph SVG is in Column 2 (another separate div). The line from x=0 only starts at the left edge of the graph column, not at the ref pills. For commits in column 0 (the most common case for commits with refs like HEAD/main), cx(0)=6 which fails the guard condition `cx(commit.column) > laneWidth` (6 is not > 12), so the line is never drawn at all. Even for commits in higher columns, the line would only span within the graph column, never reaching the ref pills.

**Issue 2 - WIP dotted line not connecting to HEAD:**
The WIP dotted line in LaneSvg.svelte (line 59-66) draws from y=17 to y=39, extending 13px below the SVG's 26px height. It relies on `overflow: visible` on the SVG element (line 55). However, the graph column div in CommitRow.svelte (line 42) has the `overflow-hidden` Tailwind class, which clips all content exceeding the div boundaries. This prevents the dotted line from visually extending into the next row.

fix: (not applied - research only)
verification: (not applied - research only)
files_changed: []
