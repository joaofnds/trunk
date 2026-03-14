---
status: diagnosed
trigger: "Commit dots and branch lines disappear when scrolling through the graph"
created: 2026-03-14T05:30:00Z
updated: 2026-03-14T05:45:00Z
---

## Current Focus

hypothesis: CONFIRMED — OVERLAY_ROW_HEIGHT (36px) does not match the actual rendered ROW_HEIGHT (26px), causing SVG element coordinates to exceed the SVG's contentHeight and get clipped by the browser
test: traced coordinate math through CommitGraph.svelte, graph-constants.ts, VirtualList.svelte
expecting: dots at high row indices (N > ~144 in a 200-commit batch) have Y coords beyond SVG height
next_action: fix OVERLAY_ROW_HEIGHT to match ROW_HEIGHT, or derive contentHeight from overlay row size

## Symptoms

expected: Scrolling through a repository with many commits — SVG overlay elements (dots, rails, connections) visible in the current viewport remain rendered throughout scrolling. DOM node count stays bounded.
actual: Commit dots and branch lines disappear when the user scrolls — elements vanish as the user moves through the graph.
errors: none reported
reproduction: Test 6 in UAT — scroll through a large repository (100+ commits) and observe the SVG overlay
started: Discovered during UAT after Phase 23 execution

## Eliminated

- hypothesis: off-by-one errors in getVisibleOverlayElements range intersection logic
  evidence: The filter logic (path.maxRow >= startRow && path.minRow <= endRow and node.y >= startRow && node.y <= endRow) is correct. Tests in overlay-visible.test.ts all cover boundary cases and pass. The inclusive endRow semantics are consistent with how visibleItems.end is used (it includes a bufferSize=20 overshoot beyond the true viewport, so elements are never excluded by the filter).
  timestamp: 2026-03-14T05:40:00Z

- hypothesis: incorrect row indices passed as visibleStart/visibleEnd to the overlay snippet
  evidence: VirtualList.svelte line 644 passes visibleItems.start and visibleItems.end directly. These are the buffer-extended render range used for slicing displayItems. The overlay filter receives the same indices and filters by node.y — the row indices in OverlayNode.y are the same coordinate space (commit index in displayItems). No index transformation error here.
  timestamp: 2026-03-14T05:40:00Z

- hypothesis: scroll position not correctly translated to row indices
  evidence: calculateVisibleRange in virtual-list/utils/virtualList.js uses scrollTop / itemHeight (averageHeight from height manager, initialized to ROW_HEIGHT=26). This correctly produces row indices matching displayItems positions. The threshold optimization in visibleItems ($derived.by) returns lastVisibleRange for small deltas but always recalculates at >= 0.5 * averageHeight. Not the cause.
  timestamp: 2026-03-14T05:42:00Z

## Evidence

- timestamp: 2026-03-14T05:32:00Z
  checked: src/lib/graph-constants.ts
  found: ROW_HEIGHT = 26, OVERLAY_ROW_HEIGHT = 36 — two different constants for the same conceptual row height
  implication: The actual rendered rows are 26px tall; the SVG overlay uses 36px per row for its coordinate math

- timestamp: 2026-03-14T05:33:00Z
  checked: src/components/CommitRow.svelte line 46
  found: style:height="{ROW_HEIGHT}px" — all commit rows are rendered at 26px
  implication: The VirtualList height manager measures items at ~26px, so totalHeight ≈ numItems * 26

- timestamp: 2026-03-14T05:33:00Z
  checked: src/components/CommitGraph.svelte line 485
  found: defaultEstimatedItemHeight={ROW_HEIGHT} (26px) passed to VirtualList
  implication: VirtualList totalHeight is computed from 26px row heights

- timestamp: 2026-03-14T05:34:00Z
  checked: src/components/CommitGraph.svelte lines 272, 432-436
  found: overlayCy = (row) => row * OVERLAY_ROW_HEIGHT + OVERLAY_ROW_HEIGHT / 2 — uses 36px. The SVG element has height={contentHeight} where contentHeight comes from VirtualList (Math.max(height, totalHeight) ≈ numItems * 26).
  implication: Dots are drawn at pixel Y = row * 36 + 18. The SVG height is ≈ numItems * 26. For row N where N * 36 > numItems * 26, the dot falls outside the SVG's bounds.

- timestamp: 2026-03-14T05:35:00Z
  checked: coordinate math for disappearance threshold
  found: For 200 commits: contentHeight ≈ 200 * 26 = 5200px. Dots disappear when N * 36 + 18 > 5200, i.e. N > ~144. So roughly 72% of items in the first batch render correctly; the bottom 28% are clipped. As the user scrolls to lower rows (higher N), their dots are clipped.
  implication: Disappearance accelerates as the user scrolls down because more high-index rows come into view. With 100+ commits the threshold is proportionally lower.

- timestamp: 2026-03-14T05:36:00Z
  checked: VirtualList.svelte line 344-348 (contentHeight derivation)
  found: contentHeight = Math.max(height, totalHeight) — both height and totalHeight are based on measured/estimated item heights at ROW_HEIGHT=26px
  implication: SVG gets height = numItems * 26 (approximately), while overlay coordinate system expects numItems * 36

- timestamp: 2026-03-14T05:38:00Z
  checked: src/components/VirtualList.svelte line 644
  found: {@render overlaySnippet(contentHeight, visibleItems.start, visibleItems.end)} — visibleItems.end is exclusive (slice-style). getVisibleOverlayElements uses <= endRow (inclusive). This means one extra row is included in the filter (the row at index visibleItems.end is included even though it's not rendered). This is harmless/slightly beneficial — it doesn't cause disappearance.
  implication: Minor semantic mismatch but not the root cause

- timestamp: 2026-03-14T05:39:00Z
  checked: src/lib/overlay-visible.ts — the filtering logic
  found: Correctly filters by row index. The filtered elements ARE included in visible.rails/connections/dots when the user scrolls. The problem is that after filtering, the elements are rendered in the SVG at wrong Y coordinates that exceed the SVG height.
  implication: The filter works correctly; the bug is in coordinate math after filtering

## Resolution

root_cause: |
  OVERLAY_ROW_HEIGHT (36px) in graph-constants.ts does not match the actual rendered row height ROW_HEIGHT (26px).

  The SVG overlay has height={contentHeight} where contentHeight is derived from VirtualList's totalHeight — computed from real measured item heights (~26px each). But the overlay draws all SVG elements using OVERLAY_ROW_HEIGHT=36 as the row unit:
    - overlayCy(row) = row * 36 + 18
    - overlayCx(col) = col * 16 + 8
    - buildRailPath uses cy/rowTop/rowBottom with OVERLAY_ROW_HEIGHT=36

  For a repository with N commits, the SVG height ≈ N * 26px, but a dot at row index R is drawn at pixel Y = R * 36 + 18. When R * 36 > N * 26 (i.e., R > N * 26/36 ≈ 0.72 * N), the dot falls outside the SVG's declared height and is clipped by the browser's SVG rendering.

  With 200 commits: clipping begins at row ~144 (72%). With 100 commits: clipping begins at row ~72. As the user scrolls down, they enter the zone where all overlay elements are clipped.

  Rails spanning from low rows to high rows (minRow small, maxRow large) will have their lower portions clipped — appearing to terminate partway through.

fix: ""
verification: ""
files_changed:
  - src/lib/graph-constants.ts (OVERLAY_ROW_HEIGHT must equal ROW_HEIGHT = 26, OR)
  - src/lib/overlay-paths.ts (coordinate math uses OVERLAY_ROW_HEIGHT — would all auto-correct if constant changes)
  - src/components/CommitGraph.svelte (overlayCy/overlayCx use OVERLAY_ROW_HEIGHT/OVERLAY_LANE_WIDTH — would auto-correct)

fix_direction: |
  Option A (simplest): Change OVERLAY_ROW_HEIGHT from 36 to 26 (= ROW_HEIGHT). All path coordinates in overlay-paths.ts and overlayCy in CommitGraph.svelte will then align with the actual SVG height derived from VirtualList.

  Option B: Keep OVERLAY_ROW_HEIGHT=36 and compute the SVG height independently as numItems * OVERLAY_ROW_HEIGHT instead of using contentHeight from VirtualList. Also requires repositioning the SVG so its coordinate space aligns with the scrollable area — complex because VirtualList drives scroll position.

  Option A is strongly preferred: the SVG overlay sits *inside* the scroll container and must use the same row pitch as the HTML rows. The 36px value was likely aspirational/design intent that was never reconciled with the actual CommitRow height of 26px.
