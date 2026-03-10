---
created: 2026-03-10T00:57:21.706Z
title: Make commit dot bigger and lanes thinner
area: ui
files: []
---

## Problem

The commit dots in the git graph are too small and the lane columns are wider than necessary, making the graph feel sparse. Increasing the dot size improves scannability and reducing lane width makes the graph more compact.

## Solution

Increase the radius/size of the commit dot SVG circles and reduce the lane (column) width in the graph layout.
