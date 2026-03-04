---
phase: 02-repository-open-commit-graph
plan: "05"
subsystem: frontend
tags: [svelte, svelte-virtual-list, svg, components]
status: complete
---

## What Was Built

Four commit graph frontend components that consume pre-computed GraphCommit data from the Rust backend.

## Key Files

### Created
- `src/components/LaneSvg.svelte` — Inline SVG: Straight edges as lines, Fork/Merge as Bézier curves; merge dot r=6+ring, regular dot r=4
- `src/components/RefPill.svelte` — Colored pill badge per RefType with +N overflow tooltip
- `src/components/CommitRow.svelte` — Three-column row: ref pills (120px) | LaneSvg | short_oid + summary
- `src/components/CommitGraph.svelte` — SvelteVirtualList host with 200-item pagination, skeleton loading, mid-scroll error+Retry

## Decisions

- Lane colors use `var(--lane-{color_index % 8})` CSS custom properties
- SVG width computed from maxCol across all edges + commit.column to avoid 0-width SVG
- CommitGraph initial load error stays in graph area (user not redirected to welcome)
- No reset on repoPath change — component is unmounted/remounted by App.svelte

## Self-Check: PASSED

- `bun run build` exits 0 ✓
- SvelteVirtualList imported and used ✓
- onLoadMore / loadMoreThreshold / hasMore wired ✓
- is_merge drives dot size in LaneSvg ✓
- RefPill and LaneSvg imported in CommitRow ✓
- animate-pulse skeleton rows present ✓
