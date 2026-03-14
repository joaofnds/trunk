---
status: diagnosed
trigger: "SVG overlay appears beside the graph instead of positioned on top of it"
created: 2026-03-14T05:10:00Z
updated: 2026-03-14T05:15:00Z
---

## Current Focus

hypothesis: SVG has `position: absolute` but its parent `.virtual-list-content` is `position: relative` with `width: 100%` — the SVG is correctly parented but is NOT constrained to only the graph column width; however, the real problem is that the SVG has an explicit `width` set to only the graph lane columns, while the items div takes full width. Both the SVG and items div are siblings inside `.virtual-list-content`, and since `.virtual-list-items` is `position: absolute` (top: 0, left: 0), it overlaps the SVG perfectly. BUT the SVG itself has `class="absolute top-0 left-0"` which positions it inside `.virtual-list-content` (which is `position: relative`) — so the SVG should be at top-left of the content area. CONFIRMED ROOT CAUSE: The SVG is placed as a sibling BEFORE the items div in the DOM. With `.virtual-list-content` being `position: relative`, the SVG uses `position: absolute; top: 0; left: 0;` — but `.virtual-list-items` is ALSO `position: absolute; top: 0; left: 0`. The SVG should overlap the items. The actual problem: the SVG width is only the graph column lanes width (e.g. `maxColumns * OVERLAY_LANE_WIDTH` = a small pixel value), while the CommitRow graph column starts at a horizontal OFFSET from the left edge of the viewport (after the Ref column). The SVG is anchored at `left: 0` of the scroll container, but the Graph column in each row has a left offset equal to the ref column width. So the SVG renders at left:0 (the start of the viewport) while the graph content it should overlay starts further to the right.
test: Examined DOM structure and CSS positioning
expecting: SVG left:0 should align with the graph column's left edge
next_action: DONE — root cause confirmed

## Symptoms

expected: SVG overlay appears on top of the commit graph column — colored lane rails, bezier curves, and commit dots overlaid on the graph column content
actual: SVG overlay appears beside (to the left of) the graph content — it renders at left:0 of the scroll container, but the graph column starts after the Ref column
errors: none
reproduction: Open app with a repository, observe Graph column
started: UAT after Phase 23 execution

## Eliminated

- hypothesis: SVG not positioned absolute at all
  evidence: SVG has `class="absolute top-0 left-0"` and `.virtual-list-content` is `position: relative` — absolute positioning IS active
  timestamp: 2026-03-14T05:12:00Z

- hypothesis: z-index conflict hiding the SVG behind rows
  evidence: SVG has `z-index: 1` and `.virtual-list-items` has no z-index set — SVG would render on top. The issue is positional (x-axis), not z-axis
  timestamp: 2026-03-14T05:12:00Z

- hypothesis: overlaySnippet not rendered inside the scroll container
  evidence: VirtualList.svelte line 643-645 renders `overlaySnippet` inside `.virtual-list-content` (the scrollable content div) — placement is correct
  timestamp: 2026-03-14T05:13:00Z

## Evidence

- timestamp: 2026-03-14T05:11:00Z
  checked: VirtualList.svelte DOM structure (lines 629-664)
  found: |
    - `.virtual-list-container` → position: relative
    - `.virtual-list-viewport` → position: absolute, top/left/right/bottom: 0, overflow-y: scroll
    - `.virtual-list-content` → position: relative, width: 100%, height: contentHeight px
    - overlaySnippet rendered inside `.virtual-list-content` BEFORE `.virtual-list-items`
    - `.virtual-list-items` → position: absolute, width: 100%, left: 0, top: 0 + translateY
  implication: SVG is a child of `.virtual-list-content` (position:relative), so `absolute top-0 left-0` anchors it to the top-left of the content area. This is correct for the scroll container's coordinate space.

- timestamp: 2026-03-14T05:12:00Z
  checked: CommitGraph.svelte SVG element (lines 432-436)
  found: |
    ```svelte
    <svg
      class="absolute top-0 left-0"
      width={Math.max(maxColumns, 1) * OVERLAY_LANE_WIDTH}
      height={contentHeight}
      style="pointer-events: none; z-index: 1;"
    >
    ```
    SVG width = only the number of graph lane columns × OVERLAY_LANE_WIDTH (e.g., 3 lanes × 16px = 48px)
    SVG is positioned at left: 0 of the scroll container's content area.
  implication: SVG starts at the very left edge of the scroll container.

- timestamp: 2026-03-14T05:13:00Z
  checked: CommitGraph.svelte header row layout (lines 361-400) and VirtualList items (CommitRow)
  found: |
    The header row is a flex container with columns in this order:
    1. Ref column (width: columnWidths.ref = 120px, if visible)
    2. Graph column (width: columnWidths.graph = 120px)
    3. Message column (flex-1)
    4. Author, Date, SHA columns
    
    The graph column in each CommitRow also starts after the Ref column — it is NOT at left: 0.
    The Ref column default width is 120px.
  implication: The Graph column content starts at approximately x=120px (after the Ref column), but the SVG overlay is positioned at x=0 (left edge). The SVG renders 120px to the LEFT of where the graph column is — i.e., "to the side" (beside), not on top.

- timestamp: 2026-03-14T05:14:00Z
  checked: How CommitRow uses the graph column offset
  found: |
    In CommitGraph.svelte the overlay SVG `left: 0` is correct relative to the scroll container,
    but should be `left: {refColumnWidth}px` (or whatever horizontal offset the graph column starts at).
    The SVG needs to be offset by the cumulative width of all columns to its left (Ref column = 120px by default).
  implication: The fix is to add a `left` offset to the SVG equal to the Ref column width (when visible), so it aligns with the graph column.

## Resolution

root_cause: |
  The SVG overlay is anchored at `left: 0` of the scroll container, but the Graph column it should
  overlay starts after the Ref column (default 120px wide). The SVG renders at the far-left edge of
  the viewport while the actual graph lane content is indented by ~120px (ref column width).
  
  Specifically in CommitGraph.svelte line 432-436:
    ```svelte
    <svg
      class="absolute top-0 left-0"   ← left: 0 is wrong; should be left: {refColumnWidth}px
      width={Math.max(maxColumns, 1) * OVERLAY_LANE_WIDTH}
      ...
    >
    ```
  
  The SVG needs a `left` style equal to the Ref column width (when visible) so it aligns with
  the start of the Graph column in each CommitRow.

fix: ""
verification: ""
files_changed: []
