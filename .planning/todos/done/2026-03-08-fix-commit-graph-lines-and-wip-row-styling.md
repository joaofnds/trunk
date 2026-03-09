---
created: 2026-03-08T03:37:00.345Z
title: Fix commit graph lines and WIP row styling
area: ui
files:
  - src/lib/components/CommitGraph.svelte
---

## Problem

The commit graph is currently missing the vertical/connecting lines between commits — only the dots are visible but the graph lines that connect them are absent. Additionally, the WIP row at the top looks off (likely positioning, dot style, or label rendering issues compared to regular commit rows).

Screenshot captured 2026-03-08 shows: WIP row at top with no connecting line to the commit below it, and no lines connecting any of the commits in the graph column.

## Solution

- Render the vertical lines between commit dots in CommitGraph (likely SVG path or CSS border approach)
- Fix WIP row to align visually with the rest of the graph (hollow dot, correct lane alignment, connecting line to first real commit)
