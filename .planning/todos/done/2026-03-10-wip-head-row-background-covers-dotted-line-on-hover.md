---
created: 2026-03-10T00:54:05.451Z
title: WIP HEAD row background covers dotted line on hover
area: ui
files: []
---

## Problem

When hovering over the WIP's HEAD commit row, the row background highlight is rendered on top of the dotted WIP connector line, causing the dotted line to get cut off. Hovering over the WIP row itself (non-HEAD) works correctly — the dotted line remains visible. The issue is a z-index or paint-order problem where the HEAD commit row's hover background paints over the graph's dotted connector line.

## Solution

Ensure the dotted WIP connector line is painted above (higher z-index / later in paint order than) the row hover background for the HEAD commit. May need to adjust the stacking context of the graph column or the row highlight layer.
