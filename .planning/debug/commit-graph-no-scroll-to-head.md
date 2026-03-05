---
status: diagnosed
trigger: "after switching branches via the sidebar, the commit graph remounts correctly (via {#key graphKey}) but does not scroll to the new HEAD commit. If the HEAD is far down the history, it's not visible."
created: 2026-03-04T00:00:00Z
updated: 2026-03-04T00:01:00Z
symptoms_prefilled: true
goal: find_root_cause_only
---

## Current Focus

hypothesis: CONFIRMED — Scroll-to-HEAD logic is completely absent. CommitGraph.svelte has no onMount, no $effect that scrolls, and no bind:this on the virtual list. The virtual list always starts at offset 0.
test: Read all relevant files end to end
expecting: No scrollIntoView or scroll offset logic
next_action: return diagnosis

## Symptoms

expected: After switching branches, the commit graph scrolls so the HEAD commit (top of new branch) is visible
actual: The commit graph remounts at scroll position 0 (top of virtual list); if HEAD is far down the history (e.g. an old branch), it is not visible
errors: none — visual/UX bug only
reproduction: Switch to a branch whose HEAD is not near the top of the global commit list; commit graph remounts but HEAD is not in view
started: unknown — possibly always

## Eliminated

- hypothesis: Backend does not return is_head info, so the frontend cannot locate the HEAD row
  evidence: GraphCommit struct (src-tauri/src/git/types.rs line 53) has `is_head: bool`; graph.rs line 139 sets it via `refs.iter().any(|r| r.is_head)`; TypeScript type (src/lib/types.ts line 35) mirrors it. Data is available.
  timestamp: 2026-03-04T00:01:00Z

- hypothesis: SvelteVirtualList does not expose a programmatic scroll API
  evidence: SvelteVirtualList.svelte.d.ts lines 145 and 170 expose both `scrollToIndex(index, smoothScroll?, shouldThrowOnBounds?)` (deprecated) and `scroll(options: SvelteVirtualListScrollOptions)` (preferred). The `scroll` API accepts `{ index, smoothScroll?, align? }`.
  timestamp: 2026-03-04T00:01:00Z

## Evidence

- timestamp: 2026-03-04T00:01:00Z
  checked: src/components/CommitGraph.svelte (entire file, 117 lines)
  found: No `bind:this`, no `onMount`, no `$effect` that calls scroll, no `scrollIntoView`, no variable holding a ref to the virtual list instance
  implication: The component has zero scroll-to-HEAD logic. On every mount (including after a branch switch) the virtual list initialises at scroll offset 0.

- timestamp: 2026-03-04T00:01:00Z
  checked: src/App.svelte — graphKey / {#key} block
  found: handleRefresh() increments graphKey by 1, which destroys and recreates <CommitGraph>. No additional context (e.g. a target HEAD oid/index) is passed to the new instance.
  implication: The remount is clean but carries no "scroll target" information.

- timestamp: 2026-03-04T00:01:00Z
  checked: src/components/BranchSidebar.svelte — handleCheckout
  found: After `checkout_branch` succeeds: (1) loadRefs() refreshes the sidebar, (2) onrefreshed?.() is called (→ handleRefresh in App.svelte → graphKey++). No HEAD oid or index is forwarded.
  implication: The branch-switch trigger chain ends at a simple remount with no scroll target.

- timestamp: 2026-03-04T00:01:00Z
  checked: src-tauri/src/git/graph.rs — walk_commits / GraphCommit
  found: is_head is set at line 139. The backend already marks which commit is HEAD in every batch. The frontend therefore already receives commits with is_head=true in the first batch (offset=0..200).
  implication: The HEAD commit's index can be derived purely on the frontend: after the first batch loads, `commits.findIndex(c => c.is_head)` gives its row index within the already-loaded slice.

- timestamp: 2026-03-04T00:01:00Z
  checked: src-tauri/src/commands/history.rs — get_commit_graph
  found: Returns a raw page slice [offset..offset+200]. It does not return a separate "head_index" field. The HEAD position in the global list is implicit: it is the index of the commit where is_head===true.
  implication: If HEAD is within the first batch (offset 0–199), the index is directly findable. If HEAD is outside the first 200 commits (extremely old branch), more batches must be loaded first — but this is an edge case; the common path is HEAD in the first batch.

- timestamp: 2026-03-04T00:01:00Z
  checked: @humanspeak/svelte-virtual-list dist/SvelteVirtualList.svelte.d.ts + types.d.ts
  found: `scroll(options: SvelteVirtualListScrollOptions): Promise<void>` where options = `{ index: number, smoothScroll?: boolean, align?: 'auto'|'top'|'bottom'|'nearest' }`. Accessed via `bind:this={listRef}` then `listRef.scroll(...)`.
  implication: The virtual list already has everything needed for programmatic scroll-to-index.

## Resolution

root_cause: >
  CommitGraph.svelte contains no scroll-to-HEAD logic whatsoever. After the component mounts
  (triggered by {#key graphKey} in App.svelte incrementing on branch switch), the
  SvelteVirtualList initialises at scroll offset 0 and stays there. No code ever reads the
  is_head field from the loaded commits and translates it into a scroll call on the list
  instance. The virtual list API (scroll / scrollToIndex) is never invoked.

fix: N/A (diagnose only)
verification: N/A
files_changed: []
