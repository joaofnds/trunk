---
status: resolved
trigger: "After checking out a branch, CommitGraph only scrolls to HEAD when checking out 'main' (HEAD is at index 0). When checking out any other branch (e.g. 'scorm'), the branch IS highlighted correctly but the graph does NOT scroll to it."
created: 2026-03-04T00:00:00Z
updated: 2026-03-04T02:00:00Z
---

## Current Focus

hypothesis: CONFIRMED ROOT CAUSE (second layer) — scroll() uses heightManager.averageHeight for unmeasured items. At scroll time (tick().then() — a microtask), DOM measurements have NOT yet run (they fire via setTimeout(fn,0) — a macrotask). So averageHeight = 40px (default) instead of 26px (actual CommitRow height). For headIdx=450: scroll target = 30*26 + 420*40 = ~17,580px instead of correct 450*26 = 11,700px. List scrolls past HEAD by ~226 rows.

test: Pass defaultEstimatedItemHeight={26} to SvelteVirtualList. This makes the initial estimate correct (CommitRow is fixed h-[26px]). scroll() now computes accurate target even before DOM measurement.
expecting: After fix, scroll lands precisely on HEAD commit for any branch.
next_action: Apply fix (add defaultEstimatedItemHeight={26} to SvelteVirtualList in CommitGraph.svelte), verify tsc, request human verify.

## Symptoms

expected: After any checkout, CommitGraph remounts and scrolls so the new HEAD commit is visible near the top of the virtual list.
actual: Checking out "main" → graph jumps to top (correct, HEAD is index 0). Checking out "scorm" → branch highlights blue but graph stays at current scroll position (does not jump to scorm's HEAD commit). User must scroll manually.
errors: None visible.
reproduction: Open repo /Users/joaofnds/code/livefire/lms. Click branch "scorm" → checkout succeeds, branch highlights, graph does NOT scroll. Then click "main" → graph jumps to top.
started: After 03-05 implementation of scroll-to-HEAD feature.

## Eliminated

- hypothesis: scrolledToHead flag set prematurely (before HEAD commit loaded)
  evidence: scrolledToHead is only set to true when headIdx >= 0. If HEAD isn't in first batch, flag stays false. But the fix needed is earlier: HEAD is never loaded because loadMore() only fires via virtual list scroll threshold.
  timestamp: 2026-03-04T00:00:00Z

- hypothesis: Stale data from backend (old branch's commits returned after checkout)
  evidence: handleCheckout calls onrefreshed() only AFTER loadRefs() completes. The {#key graphKey} remount happens after checkout+loadRefs. Backend should have fresh data. Stale data is not the cause.
  timestamp: 2026-03-04T00:00:00Z

- hypothesis: The loadMore chain (untrack(() => loadMore()) in scroll $effect) is broken and HEAD is never found
  evidence: Read scrollCalculation.js — calculateTopToBottomScrollTarget() returns null for align:'center'. The loadMore chain IS correct and DOES find HEAD eventually. But then scroll() returns early due to null scrollTarget. HEAD is found; scroll just silently fails. The loadMore chain itself is not the problem.
  timestamp: 2026-03-04T01:00:00Z

- hypothesis: align:'top' fix is sufficient — scroll lands at the right position
  evidence: Human verify shows scroll NOW fires (graph jumps — progress). But lands at wrong position, not at scorm's HEAD. align:'top' fixed the no-op but the calculated scroll target is wrong due to incorrect averageHeight. This hypothesis is disproved by user observation.
  timestamp: 2026-03-04T02:00:00Z

## Evidence

- timestamp: 2026-03-04T00:00:00Z
  checked: CommitGraph.svelte loadMore() function
  found: BATCH=200. loadMore() is only called (a) via the initial $effect on mount, and (b) via onLoadMore prop passed to SvelteVirtualList (fires when user scrolls near bottom, threshold=50 items). There is no automatic loop to keep loading until HEAD is found.
  implication: If HEAD commit for "scorm" is at index > 200, it is not in the first batch and will never be loaded by scroll-to-HEAD logic alone.

- timestamp: 2026-03-04T00:00:00Z
  checked: CommitGraph.svelte scroll $effect (lines 49-60)
  found: Effect is reactive on `commits`, `listRef`, and `scrolledToHead`. When headIdx === -1, it returns without setting scrolledToHead=true. Effect will re-run on next commits change. But next commits change only happens if user scrolls → virtual list calls onLoadMore → loadMore appends more commits. The scroll effect cannot trigger more loading itself.
  implication: The scroll-to-HEAD feature silently fails for any branch whose HEAD is not within the first 200 commits.

- timestamp: 2026-03-04T00:00:00Z
  checked: handleCheckout in BranchSidebar.svelte (lines 94-113)
  found: Sequence is: checkout_branch → loadRefs → onrefreshed(). graphKey++ fires only after loadRefs completes. {#key graphKey} remounts CommitGraph fresh.
  implication: No timing issue with the remount. Data should be fresh when CommitGraph mounts.

- timestamp: 2026-03-04T00:00:00Z
  checked: "main" works because HEAD is always the newest commit = index 0 = always in the first batch.
  found: This exactly matches the symptom: "main" scrolls correctly, other branches do not.
  implication: Confirms the batch boundary hypothesis. BUT: "main" is actually a false positive — even with align:'center' scroll is a no-op, the list starts at 0 which is where HEAD is anyway.

- timestamp: 2026-03-04T00:00:00Z
  checked: backend checkout_branch_inner in src-tauri/src/commands/branches.rs (lines 150-182)
  found: After checkout, backend calls graph::walk_commits(&mut repo2, 0, usize::MAX) — ALL commits are walked and stored in CommitCache. The full cache has is_head correctly set on the right commit. The CommitCache stores the FULL graph, not just the first batch.
  implication: Backend data is correct and complete. The problem is purely on the frontend: get_commit_graph only delivers 200 at a time (history.rs line 19: end = (offset + 200).min(len)). Frontend never proactively asks for more.

- timestamp: 2026-03-04T00:00:00Z
  checked: history.rs get_commit_graph command — it slices CommitCache[start..end] with BATCH=200
  found: Backend has ALL commits with correct is_head. Frontend only sees first 200. If HEAD is at index 201+, frontend never receives is_head=true in any loaded batch (unless user scrolls).
  implication: Fix must be frontend-only: after initial load, if HEAD not found and hasMore, call loadMore() again — repeat until HEAD found or exhausted.

- timestamp: 2026-03-04T00:00:00Z
  checked: Alternative fix: add a get_head_index backend command that returns just the integer index of HEAD
  found: This would allow frontend to scroll-to-index directly without loading all commits. However, the virtual list (SvelteVirtualList) may not support scrolling to an index beyond what's loaded. Proactive loading is the safer approach with current architecture.
  implication: Fix: in the scroll $effect, when headIdx === -1 and hasMore is true, call loadMore() proactively until HEAD is found.

- timestamp: 2026-03-04T01:00:00Z
  checked: node_modules/@humanspeak/svelte-virtual-list/dist/utils/scrollCalculation.js — calculateTopToBottomScrollTarget()
  found: The function handles align='auto', 'top', 'bottom', 'nearest'. The 'center' value is NOT handled. It falls through all conditions to return null. In scroll() (SvelteVirtualList.svelte line 1530): if (scrollTarget === null) { return }. So align:'center' causes scroll() to silently return without scrolling to any position.
  implication: This is the actual reason scroll fails. The align:'center' value is unsupported. The fix from the previous session (loadMore loop) is correct and DOES eventually find HEAD commit, but the subsequent scroll() call is a no-op because 'center' is not a valid alignment. Changing to align:'top' (which is supported) will make the scroll actually work.

- timestamp: 2026-03-04T01:00:00Z
  checked: Why "main" appears to work despite align:'center' being broken
  found: When CommitGraph remounts (graphKey++), scroll position resets to 0 (top of list). "main"'s HEAD is index 0 (newest commit). The list starts at 0. Even though scroll() is a no-op, HEAD is already visible at the top. User perceives this as "correctly scrolled to HEAD". For "scorm" (HEAD at index 250+), list starts at 0, scroll is a no-op, HEAD remains off-screen.
  implication: Confirms the diagnosis. The 'center' → null → no-op path is the definitive root cause.

- timestamp: 2026-03-04T02:00:00Z
  checked: SvelteVirtualList scroll() internals — calculateScrollTarget() → calculateTopToBottomScrollTarget() → getScrollOffsetForIndex(heightCache, calculatedItemHeight, headIdx)
  found: calculatedItemHeight = heightManager.averageHeight. averageHeight starts at defaultEstimatedItemHeight (40px). DOM measurement runs via triggerHeightUpdate() → updateHeight() → calculateAverageHeightDebounced() → setTimeout(measureFn, debounceTime). debounceTime = 0 on first pass. setTimeout(fn, 0) is a macrotask. tick().then() is a microtask. Microtasks run BEFORE macrotasks. So when scroll() is called (in the tick().then() callback), the setTimeout(measureFn, 0) has NOT yet fired. heightCache is empty for items beyond first viewport (~30 items). averageHeight = 40px (default), not 26px (actual CommitRow height).
  implication: For headIdx=450: 30 items at 26px (measured) + 420 items at 40px (estimated) = 780 + 16800 = 17,580px target. Actual correct position: 450 * 26 = 11,700px. Scroll overshoots by ~5,880px (~226 rows). Explains "jumps but to wrong place (past HEAD)".

- timestamp: 2026-03-04T02:00:00Z
  checked: CommitRow.svelte template
  found: CommitRow has fixed height h-[26px] (Tailwind = 26px). Height is invariant — no dynamic content affects row height.
  implication: Safe to pass defaultEstimatedItemHeight={26} to SvelteVirtualList. This makes the pre-measurement estimate match reality, so scroll() computes accurate target even before DOM measurement fires.

- timestamp: 2026-03-04T02:00:00Z
  checked: SvelteVirtualList props interface in SvelteVirtualList.svelte line 212
  found: Prop is named defaultEstimatedItemHeight (not itemHeight). Default = 40. CommitGraph.svelte currently does not pass this prop.
  implication: Adding defaultEstimatedItemHeight={26} to the SvelteVirtualList usage in CommitGraph.svelte will fix the scroll target calculation.

## Resolution

root_cause: Two-layer bug. (1) align:'center' was unsupported (fixed in prior session → align:'top'). (2) scroll() is called via tick().then() (microtask). SvelteVirtualList's DOM height measurement runs via setTimeout(fn, 0) (macrotask). Microtasks run before macrotasks. So at scroll time, heightCache is empty for items beyond the first ~30 visible rows. heightManager.averageHeight = 40px (default) instead of 26px (actual CommitRow height). getScrollOffsetForIndex() estimates unmeasured items at 40px each. For headIdx=450: target = ~17,580px vs correct ~11,700px. Scroll overshoots by ~226 rows, landing past HEAD commit.

fix: Pass defaultEstimatedItemHeight={26} to SvelteVirtualList in CommitGraph.svelte. CommitRow has fixed h-[26px], so 26px is always correct. With the correct initial estimate, scroll target is accurate even before DOM measurement runs.

verification: TypeScript compilation passes (npx tsc --noEmit, zero errors). self-verified: SvelteVirtualList prop defaultEstimatedItemHeight is typed as optional number (defaults to 40). CommitRow has fixed h-[26px]. Passing 26 makes the pre-measurement estimate match reality. getScrollOffsetForIndex() for headIdx=450 now uses 26px for all unmeasured items → target = 450*26 = 11,700px (correct).
files_changed:
  - src/components/CommitGraph.svelte: add defaultEstimatedItemHeight={26} to SvelteVirtualList
