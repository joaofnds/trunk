---
phase: quick
plan: 7
subsystem: ui
tags: [refs, overflow, pill, hover, layout]
dependency_graph:
  requires: [quick-6]
  provides: [vertical-ref-overlay]
  affects: [CommitRow.svelte, RefPill.svelte]
tech_stack:
  added: []
  patterns: [tailwind flex-col layout, w-full pill span]
key_files:
  created: []
  modified:
    - src/components/CommitRow.svelte
    - src/components/RefPill.svelte
decisions:
  - "Overlay uses flex-col + rounded-lg instead of flex-row + rounded-full for better vertical scannability"
  - "w-full on each pill span stretches refs to full overlay width for uniform appearance"
metrics:
  duration: 3min
  completed_date: "2026-03-10"
---

# Quick Task 7: Transform Overflow Pill into Vertical List Summary

**One-liner:** Converted hover-expanded ref overlay from horizontal rounded-full pill row to a vertical rounded-lg dropdown with one full-width pill per line.

## What Was Done

Transformed the hover overlay that shows all refs on a multi-ref commit from a horizontal pill-shaped container into a vertically-stacked rounded-rectangle popup.

### Changes Made

**src/components/CommitRow.svelte (expanded overlay div):**
- `rounded-full` -> `rounded-lg` (square-ish container shape)
- `flex items-center gap-1` -> `flex flex-col` (vertical stack layout)
- `px-2 py-0.5` -> `px-2 py-1.5` (more vertical breathing room)

**src/components/RefPill.svelte (showAll branch):**
- `flex items-center gap-1` -> `flex flex-col gap-0.5` (vertical stack)
- Added `w-full` to each ref `<span>` so pills stretch full overlay width

## Deviations from Plan

None - plan executed exactly as written.

## Verification

- `npm run check` passes (pre-existing error in CommitGraph.svelte unrelated to these changes; no new errors introduced)
- Overlay now renders as a vertical rounded-rectangle dropdown with one pill per row

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Switch overlay to vertical list layout | dfa6b4b | src/components/CommitRow.svelte, src/components/RefPill.svelte |

## Self-Check: PASSED

- [x] src/components/CommitRow.svelte modified
- [x] src/components/RefPill.svelte modified
- [x] Commit dfa6b4b exists
