---
created: 2026-03-10T01:11:52.547Z
title: Second commit connector line disconnected from first commit
area: ui
files: []
---

## Problem

The connector line between the 2nd commit and the 1st (initial) commit appears disconnected/broken. This reproduces across all repos checked. There is a visible gap between the bottom of the "docs: initialize pr..." commit dot and the top of the "initial commit" dot.

The line should always come out of the bottom of the child commit dot and go down to the top of the parent commit dot (when one is above the other). The gap suggests the connector line for the very first parent-child relationship is either not rendered at the correct position or is clipped/offset.

See screenshot: `SCR-20260309-teeu.png` — shows the gap between the last two commits at the bottom of the graph.

## Solution

Debug the connector line rendering logic. Likely the issue is in how the line segment is calculated for the bottom-most commit pair — possibly an off-by-one in the row positioning, a missing half-segment, or incorrect start/end coordinates for the final connector line segment.
