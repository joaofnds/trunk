---
phase: quick-5
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/App.svelte
  - src/components/CommitGraph.svelte
autonomous: true
requirements: [QUICK-5]

must_haves:
  truths:
    - "Committing does not cause the graph pane to flicker or flash skeleton"
    - "CommitGraph component stays mounted across refreshes (no DOM teardown)"
    - "Duplicate repo-changed events within 200ms are collapsed into a single refresh"
    - "Old commit data remains visible while new data loads, then swaps seamlessly"
  artifacts:
    - path: "src/App.svelte"
      provides: "Debounced repo-changed handler, no graphKey/key-block remount"
      contains: "refreshSignal"
    - path: "src/components/CommitGraph.svelte"
      provides: "In-place data refresh via reactive signal, no skeleton on refresh"
      contains: "refreshSignal"
  key_links:
    - from: "src/App.svelte"
      to: "src/components/CommitGraph.svelte"
      via: "refreshSignal prop increment"
      pattern: "refreshSignal"
    - from: "src/App.svelte"
      to: "@tauri-apps/api/event"
      via: "debounced repo-changed listener"
      pattern: "setTimeout|clearTimeout"
---

<objective>
Fix the graph pane flicker that occurs on every commit.

Purpose: Committing currently causes two full destroy/recreate cycles of CommitGraph (via `{#key graphKey}` and double `repo-changed` events), producing visible skeleton flashes. This plan removes the remount pattern, adds frontend debounce, and keeps old data visible during refresh.

Output: Flicker-free commit graph updates — component stays mounted, data refreshes in place, duplicate events are deduplicated.
</objective>

<execution_context>
@/Users/joaofnds/.config/Claude/get-shit-done/workflows/execute-plan.md
@/Users/joaofnds/.config/Claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/quick/5-the-ui-flickers-a-lot-when-i-commit-the-/5-CONTEXT.md
@src/App.svelte
@src/components/CommitGraph.svelte

<interfaces>
<!-- Current App.svelte patterns relevant to this fix -->

From src/App.svelte:
```typescript
// Current remount mechanism (TO BE REMOVED):
let graphKey = $state(0);
function handleRefresh() { graphKey += 1; }

// Template uses {#key graphKey} around CommitGraph (TO BE REMOVED)

// repo-changed listener (NO debounce — TO BE FIXED):
listen<string>('repo-changed', (event) => {
  if (event.payload === repoPath) {
    handleRefresh();
    loadDirtyCounts();
    if (selectedFile) { refetchFileDiff(selectedFile.path, selectedFile.kind); }
  }
});
```

From src/components/CommitGraph.svelte:
```typescript
interface Props {
  repoPath: string;
  oncommitselect?: (oid: string) => void;
  wipCount?: number;
  wipMessage?: string;
  onWipClick?: () => void;
}

let commits = $state<GraphCommit[]>([]);
let hasMore = $state(true);
let loading = $state(false);
let offset = $state(0);

// Initial load via $effect → untrack(() => loadMore())
// Skeleton shown only when: commits.length === 0 && loading
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add in-place refresh to CommitGraph and debounced trigger in App</name>
  <files>src/components/CommitGraph.svelte, src/App.svelte</files>
  <action>
**CommitGraph.svelte changes:**

1. Add `refreshSignal` prop to the Props interface:
   ```typescript
   refreshSignal?: number;
   ```
   Destructure it in $props().

2. Create a `refresh()` function that re-fetches data in place WITHOUT clearing the existing commits array first:
   ```typescript
   async function refresh() {
     // Fetch fresh data from offset 0
     try {
       const batch = await safeInvoke<GraphCommit[]>('get_commit_graph', {
         path: repoPath,
         offset: 0,
       });
       // Swap data atomically — old data stays visible until this assignment
       commits = batch;
       offset = batch.length;
       hasMore = batch.length >= BATCH;
       error = null;
     } catch (e) {
       const err = e as TrunkError;
       error = err.message ?? 'Failed to load commits';
       // Keep old commits visible on error — do NOT clear
     }
   }
   ```

3. Add a `$effect` that watches `refreshSignal` and calls `refresh()`:
   ```typescript
   $effect(() => {
     // Access refreshSignal to create reactive dependency
     if (refreshSignal !== undefined && refreshSignal > 0) {
       untrack(() => refresh());
     }
   });
   ```
   This re-fetches data when the signal increments, but does NOT unmount the component.

**App.svelte changes:**

1. Remove `graphKey` state entirely (`let graphKey = $state(0);`).

2. Add `refreshSignal` state: `let refreshSignal = $state(0);`

3. Change `handleRefresh()` to increment `refreshSignal` instead of `graphKey`:
   ```typescript
   function handleRefresh() {
     refreshSignal += 1;
   }
   ```

4. Remove the `{#key graphKey}` wrapper from the template. Change:
   ```svelte
   {#key graphKey}
     <CommitGraph {repoPath} oncommitselect={handleCommitSelect} {wipCount} wipMessage={wipSubject.trim() || 'WIP'} onWipClick={clearCommit} />
   {/key}
   ```
   To:
   ```svelte
   <CommitGraph {repoPath} oncommitselect={handleCommitSelect} {wipCount} wipMessage={wipSubject.trim() || 'WIP'} onWipClick={clearCommit} {refreshSignal} />
   ```

5. Add debounce to the `repo-changed` listener. Replace the current `$effect` that calls `listen('repo-changed', ...)` with a debounced version using a `setTimeout`/`clearTimeout` pattern (200ms debounce window):
   ```typescript
   $effect(() => {
     let unlisten: (() => void) | undefined;
     let debounceTimer: ReturnType<typeof setTimeout> | undefined;

     listen<string>('repo-changed', (event) => {
       if (event.payload === repoPath) {
         if (debounceTimer) clearTimeout(debounceTimer);
         debounceTimer = setTimeout(() => {
           handleRefresh();
           loadDirtyCounts();
           if (selectedFile) {
             refetchFileDiff(selectedFile.path, selectedFile.kind);
           }
         }, 200);
       }
     }).then((fn) => { unlisten = fn; });

     return () => {
       unlisten?.();
       if (debounceTimer) clearTimeout(debounceTimer);
     };
   });
   ```

6. Also remove `graphKey` from `handleClose()` — replace `graphKey = 0;` with `refreshSignal = 0;`.

**Per user decision:** Frontend debounce only (no Rust changes). Keep old data visible during refresh (no skeleton/spinner). In-place data refresh (no component remount).
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npx svelte-check --threshold error 2>&1 | tail -20</automated>
  </verify>
  <done>
    - CommitGraph stays mounted across refreshes (no `{#key}` wrapper)
    - `refreshSignal` prop triggers in-place data re-fetch without clearing visible commits
    - Duplicate `repo-changed` events within 200ms are collapsed into one refresh
    - Old commit data remains visible during refresh — no skeleton flash
    - `graphKey` state is fully removed from App.svelte
  </done>
</task>

<task type="auto">
  <name>Task 2: Verify no remaining graphKey references and test build</name>
  <files>src/App.svelte, src/components/CommitGraph.svelte</files>
  <action>
1. Search for any remaining references to `graphKey` in the entire `src/` directory. There should be zero.

2. Search for any remaining `{#key` blocks wrapping CommitGraph. There should be zero.

3. Verify the skeleton loading state in CommitGraph still works correctly for INITIAL load (when `commits.length === 0 && loading`) — this is fine and expected. It should NOT show skeleton during refresh (when commits already exist).

4. Run `npm run build` (or the project's build command) to confirm no TypeScript or Svelte compilation errors.

5. Verify that `refreshSignal` is properly declared in CommitGraph's Props, destructured, and used in the reactive effect.
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npm run build 2>&1 | tail -20</automated>
  </verify>
  <done>
    - Zero references to `graphKey` in src/
    - Zero `{#key` blocks wrapping CommitGraph
    - Project builds without errors
    - Skeleton only shows on initial load (commits.length === 0), never during refresh
  </done>
</task>

</tasks>

<verification>
1. `npx svelte-check --threshold error` — no type errors
2. `npm run build` — clean build with no errors
3. `grep -r "graphKey" src/` — returns nothing
4. `grep -r "{#key" src/App.svelte` — returns nothing (no key block around CommitGraph)
5. Manual verification: open a repo, make a commit, observe that the graph updates without any flash/flicker
</verification>

<success_criteria>
- CommitGraph component is never unmounted/remounted during normal operation (no `{#key}` wrapper)
- Duplicate `repo-changed` events within 200ms window produce only a single data refresh
- During refresh, old commit data stays visible until new data arrives (no skeleton, no blank state)
- Project builds and type-checks cleanly
</success_criteria>

<output>
After completion, create `.planning/quick/5-the-ui-flickers-a-lot-when-i-commit-the-/5-SUMMARY.md`
</output>
