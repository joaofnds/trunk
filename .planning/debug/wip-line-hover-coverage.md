---
status: diagnosed
trigger: "HEAD row hover background covers dotted WIP line extending from WIP row above"
created: 2026-03-09T00:00:00Z
updated: 2026-03-09T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - HEAD row's `position: relative` + opaque hover background paints over the WIP row's SVG overflow due to CSS stacking order
test: Traced full DOM structure and CSS paint order rules
expecting: n/a - root cause confirmed
next_action: Return diagnosis

## Symptoms

expected: The WIP dotted line should remain visible even when the HEAD row has a hover background
actual: When hovering over the HEAD commit row, the hover background color covers/clips the WIP dotted line
errors: none (visual bug)
reproduction: Hover over the HEAD commit row when a WIP row is present above it
started: unknown

## Eliminated

## Evidence

- timestamp: 2026-03-09T00:01:00Z
  checked: LaneSvg.svelte WIP dotted line rendering (lines 57-66)
  found: WIP dotted line draws from y=17 (cy+4) to y=39 (rowHeight+cy). SVG height is 26px, so line overflows 13px downward into next row. SVG has `overflow: visible` to allow this.
  implication: The dotted line relies on SVG overflow to extend into the HEAD row's visual space.

- timestamp: 2026-03-09T00:02:00Z
  checked: CommitRow.svelte outer div (line 31-35)
  found: Every CommitRow has `class="relative flex items-center h-[26px] px-2 hover:bg-[var(--color-surface)]"`. The `relative` class sets `position: relative`. On hover, bg is set to `--color-surface` (#161b22, fully opaque).
  implication: The HEAD row's div is positioned (`relative`) and gains an opaque background on hover.

- timestamp: 2026-03-09T00:03:00Z
  checked: Virtual list item wrapper structure (SvelteVirtualList.svelte lines 1670-1684, 1727-1730)
  found: Each item is wrapped in a `div` with no position set (defaults to `static`). Style is just `width: 100%; display: block;`. Items are siblings inside `.virtual-list-items`.
  implication: Item wrappers are `position: static`, which means their children with `position: relative` paint above prior static-flow content from sibling wrappers.

- timestamp: 2026-03-09T00:04:00Z
  checked: CSS paint order rules for this DOM structure
  found: |
    DOM structure:
    ```
    .virtual-list-items (position: absolute)
      div (wrapper, static)       <-- WIP row wrapper
        div.relative (CommitRow)  <-- WIP CommitRow
          svg (overflow: visible) <-- dotted line overflows 13px down
      div (wrapper, static)       <-- HEAD row wrapper
        div.relative (CommitRow)  <-- HEAD CommitRow, hover:bg applied
    ```
    Per CSS 2.1 painting order (Appendix E):
    - Step 4: Non-positioned floats (N/A)
    - Step 5: Non-positioned in-flow content (the static item wrappers and their descendants are painted in DOM order)
    - Step 8: Positioned elements (position: relative) are painted AFTER non-positioned content

    The WIP SVG overflow is part of the non-positioned flow (it's inside a positioned element but overflows into the space of the next static wrapper). The HEAD row's `position: relative` div with its background is a positioned element that paints at step 8, covering any step-5 content from prior siblings.
  implication: This is a fundamental CSS stacking/paint-order issue, not a z-index bug per se.

## Resolution

root_cause: |
  The WIP dotted line extends 13px below its SVG (via `overflow: visible`) into the HEAD row's space. When the HEAD row is hovered, its CommitRow div (`position: relative` + opaque `background: #161b22`) paints at a higher level in CSS paint order than the overflowing SVG content from the previous sibling. This causes the hover background to cover the dotted line.

  Specifically:
  - LaneSvg.svelte line 60: `y2={rowHeight + cy}` = 39px, but SVG height is 26px -> 13px overflow
  - CommitRow.svelte line 31: `class="relative ... hover:bg-[var(--color-surface)]"` -> positioned element with opaque bg
  - CSS paint order: positioned elements (step 8) paint over non-positioned flow content (step 5) from earlier siblings

fix:
verification:
files_changed: []
