---
phase: quick
plan: 5
subsystem: commit-graph-refresh
tags: [svelte, debounce, flicker-fix, in-place-refresh]
dependency_graph:
  requires: []
  provides: [flicker-free-graph-refresh, debounced-repo-changed]
  affects: [App, CommitGraph]
tech_stack:
  added: []
  patterns: [reactive-signal-refresh, setTimeout-debounce, atomic-data-swap]
key_files:
  modified:
    - src/App.svelte
    - src/components/CommitGraph.svelte
decisions:
  - Frontend-only debounce (200ms) instead of Rust-side dedup — simpler, no backend changes needed
  - Reactive refreshSignal prop over imperative refresh() method — idiomatic Svelte, no bind:this needed
  - Atomic data swap keeps old commits visible during fetch — no skeleton flash on refresh
metrics:
  duration_seconds: 110
  completed: "2026-03-09T05:06:26Z"
  tasks_completed: 2
  tasks_total: 2
---

# Quick Task 5: Fix Graph Pane Flicker on Commit - Summary

Replaced the destroy/recreate CommitGraph pattern (`{#key graphKey}`) with an in-place reactive refresh via `refreshSignal` prop, and added 200ms frontend debounce on the `repo-changed` listener to collapse duplicate events from Rust commit handler + filesystem watcher.

## Task Completion

| Task | Name | Commit | Files Modified |
|------|------|--------|----------------|
| 1 | Add in-place refresh to CommitGraph and debounced trigger in App | 460cd83 | App.svelte, CommitGraph.svelte |
| 2 | Verify no remaining graphKey references and test build | — (verification only) | — |

## Changes Made

### App.svelte
- Removed `graphKey` state variable and `{#key graphKey}` template wrapper entirely
- Added `refreshSignal` state variable — incremented by `handleRefresh()`, reset in `handleClose()`
- Pass `refreshSignal` as prop to CommitGraph (component stays mounted, receives signal to re-fetch)
- Added 200ms `setTimeout`/`clearTimeout` debounce on `repo-changed` listener to collapse duplicate events
- Cleanup function clears both the event unlisten and the debounce timer

### CommitGraph.svelte
- Added `refreshSignal?: number` to Props interface and destructured from `$props()`
- Added `refresh()` function that re-fetches commits from offset 0 and atomically swaps data — old commits remain visible until new data arrives, no clearing/skeleton
- Added `$effect` watching `refreshSignal` that calls `refresh()` via `untrack()` when signal increments
- Skeleton loading state unchanged — only shows on initial load (`commits.length === 0 && loading`), never during refresh

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

1. `grep graphKey src/` — zero matches (fully removed)
2. `grep '{#key' src/App.svelte` — zero matches (no key block around CommitGraph)
3. `refreshSignal` properly wired: 8 references across App.svelte and CommitGraph.svelte
4. `npm run build` — clean build, no errors (only pre-existing warnings)
5. `svelte-check --threshold error` — 1 pre-existing error (SvelteVirtualList type mismatch, unrelated), no new errors

## Self-Check: PASSED
