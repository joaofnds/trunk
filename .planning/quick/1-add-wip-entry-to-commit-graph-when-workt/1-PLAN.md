---
phase: quick-1
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - src-tauri/src/commands/staging.rs
  - src-tauri/src/lib.rs
  - src/components/CommitGraph.svelte
  - src/App.svelte
autonomous: true
requirements: [QUICK-1]

must_haves:
  truths:
    - "WIP row appears at the top of the commit graph when the working tree has staged or unstaged changes"
    - "WIP row disappears when the working tree is clean"
    - "WIP row shows a file count badge (staged + unstaged + conflicted)"
    - "Clicking the WIP row calls clearCommit() and returns to the staging panel view"
  artifacts:
    - path: "src-tauri/src/commands/staging.rs"
      provides: "get_dirty_counts Tauri command returning DirtyCounts { staged, unstaged, conflicted }"
    - path: "src/components/CommitGraph.svelte"
      provides: "WIP row rendered above virtual list when wipCount > 0"
    - path: "src/App.svelte"
      provides: "wipCount derived from get_dirty_counts, refreshed on repo-changed events"
  key_links:
    - from: "src/App.svelte"
      to: "src/components/CommitGraph.svelte"
      via: "wipCount prop"
    - from: "src/App.svelte"
      to: "get_dirty_counts IPC"
      via: "safeInvoke on mount and repo-changed"
---

<objective>
Add a synthetic "// WIP" row at the top of the commit graph that appears whenever the working tree is dirty (staged, unstaged, or conflicted files). It is not a real commit — it is a visual indicator rendered above the virtual list. Clicking it clears the selected commit and shows the staging panel.

Purpose: Mirrors GitKraken's UX so users can immediately see whether they have uncommitted work without scrolling or opening the staging panel.
Output: A new Rust command `get_dirty_counts`, a WIP row in CommitGraph.svelte, and App.svelte wiring.
</objective>

<execution_context>
@/Users/joaofnds/.claude/get-shit-done/workflows/execute-plan.md
@/Users/joaofnds/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/joaofnds/code/trunk/src-tauri/src/commands/staging.rs
@/Users/joaofnds/code/trunk/src/components/CommitGraph.svelte
@/Users/joaofnds/code/trunk/src/App.svelte
@/Users/joaofnds/code/trunk/src-tauri/src/lib.rs

<interfaces>
<!-- Key patterns used across this codebase -->

Rust IPC pattern (from staging.rs):
```rust
#[tauri::command]
pub async fn get_dirty_counts(
    state: tauri::State<'_, RepoState>,
) -> Result<DirtyCounts, TrunkError> { ... }
```

safeInvoke pattern (App.svelte):
```typescript
const result = await safeInvoke<DirtyCounts>("get_dirty_counts");
```

repo-changed event (App.svelte already listens):
```typescript
await listen("repo-changed", async () => { /* refresh */ });
```

WorkingTreeStatus (existing type in staging.rs):
```rust
pub struct WorkingTreeStatus {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add get_dirty_counts Rust command</name>
  <files>src-tauri/src/commands/staging.rs, src-tauri/src/lib.rs</files>
  <action>
In staging.rs, add a new struct and command below the existing WorkingTreeStatus definitions:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirtyCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub conflicted: usize,
}
```

Add the command:
```rust
#[tauri::command]
pub async fn get_dirty_counts(
    state: tauri::State<'_, RepoState>,
) -> Result<DirtyCounts, TrunkError> {
    let repo_path = state.path().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&repo_path)?;
        let statuses = repo.statuses(None).map_err(|e| TrunkError::from(e))?;
        let mut staged = 0usize;
        let mut unstaged = 0usize;
        let mut conflicted = 0usize;
        for entry in statuses.iter() {
            let s = entry.status();
            if s.intersects(
                git2::Status::INDEX_NEW
                    | git2::Status::INDEX_MODIFIED
                    | git2::Status::INDEX_DELETED
                    | git2::Status::INDEX_RENAMED
                    | git2::Status::INDEX_TYPECHANGE,
            ) {
                staged += 1;
            }
            if s.intersects(
                git2::Status::WT_MODIFIED
                    | git2::Status::WT_DELETED
                    | git2::Status::WT_RENAMED
                    | git2::Status::WT_TYPECHANGE,
            ) {
                unstaged += 1;
            }
            if s.intersects(git2::Status::CONFLICTED) {
                conflicted += 1;
            }
        }
        Ok(DirtyCounts { staged, unstaged, conflicted })
    })
    .await
    .map_err(|e| TrunkError { code: "JOIN_ERROR".into(), message: e.to_string() })?
}
```

In lib.rs, add `get_dirty_counts` to the `generate_handler![]` macro alongside the other staging commands.
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk/src-tauri && cargo build 2>&1 | tail -5</automated>
  </verify>
  <done>cargo build succeeds with get_dirty_counts registered; no compile errors</done>
</task>

<task type="auto">
  <name>Task 2: WIP row in CommitGraph + App.svelte wiring</name>
  <files>src/components/CommitGraph.svelte, src/App.svelte</files>
  <action>
**CommitGraph.svelte:**

Add a `wipCount` prop (number, default 0) and an `onWipClick` callback prop:
```typescript
let { commits, selectedOid, onSelect, wipCount = 0, onWipClick }: Props = $props();
```

Render a WIP row above the virtual list (outside `<VirtualList>`) when `wipCount > 0`. Use column 0 for the graph dot. Style it distinctly — italic text, muted/accent background stripe, a colored dot matching lane 0:

```svelte
{#if wipCount > 0}
  <div
    class="wip-row"
    role="button"
    tabindex="0"
    onclick={onWipClick}
    onkeydown={(e) => e.key === 'Enter' && onWipClick?.()}
  >
    <div class="wip-lane">
      <svg width="30" height="24" viewBox="0 0 30 24">
        <!-- vertical line going down to connect to HEAD -->
        <line x1="15" y1="12" x2="15" y2="24" stroke="var(--lane-0)" stroke-width="2" />
        <!-- dot -->
        <circle cx="15" cy="12" r="5" fill="var(--lane-0)" />
      </svg>
    </div>
    <div class="wip-info">
      <span class="wip-label">// WIP</span>
      <span class="wip-badge">{wipCount} file{wipCount === 1 ? '' : 's'}</span>
    </div>
  </div>
{/if}
```

Add styles (scoped):
```css
.wip-row {
  display: flex;
  align-items: center;
  height: 28px;
  cursor: pointer;
  background: color-mix(in srgb, var(--lane-0) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--lane-0) 20%, transparent);
}
.wip-row:hover { background: color-mix(in srgb, var(--lane-0) 16%, transparent); }
.wip-lane { width: 30px; flex-shrink: 0; }
.wip-info { display: flex; align-items: center; gap: 8px; padding-left: 4px; }
.wip-label { font-style: italic; font-size: 0.85rem; color: var(--lane-0); }
.wip-badge { font-size: 0.75rem; background: var(--lane-0); color: #000; border-radius: 9999px; padding: 1px 6px; }
```

**App.svelte:**

Add a `dirtyCounts` state variable initialized to `{ staged: 0, unstaged: 0, conflicted: 0 }`.

Add a `loadDirtyCounts` async function that calls `safeInvoke<DirtyCounts>("get_dirty_counts")` and, on success, sets `dirtyCounts`. Call it on mount (alongside other init calls) and inside the existing `repo-changed` event listener.

Derive `wipCount`:
```typescript
const wipCount = $derived(
  dirtyCounts.staged + dirtyCounts.unstaged + dirtyCounts.conflicted
);
```

Pass to CommitGraph:
```svelte
<CommitGraph
  ...existing props...
  wipCount={wipCount}
  onWipClick={clearCommit}
/>
```

`clearCommit` already exists (from diff integration work — it deselects the commit and shows the staging panel). If the function is named differently, use whatever clears selectedCommit/selectedFile.
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npm run check 2>&1 | tail -10</automated>
  </verify>
  <done>
- npm run check passes with no type errors
- WIP row renders above graph when worktree is dirty
- WIP row is absent when worktree is clean
- Clicking WIP row deselects commit and shows staging panel
  </done>
</task>

</tasks>

<verification>
Manual verification after both tasks pass automated checks:

1. Open a repository with staged or unstaged changes — "// WIP" row appears at top of graph with correct file count badge.
2. Stage all files and commit — WIP row disappears.
3. Make a change — WIP row reappears immediately (repo-changed event triggers refresh).
4. Click the WIP row — commit selection is cleared, staging panel is visible.
</verification>

<success_criteria>
- get_dirty_counts Tauri command compiles and returns correct counts
- CommitGraph renders WIP row above virtual list when wipCount > 0
- WIP row disappears when all counts are zero
- Clicking WIP row triggers clearCommit() behavior
- No TypeScript type errors (npm run check passes)
</success_criteria>

<output>
After completion, create `.planning/quick/1-add-wip-entry-to-commit-graph-when-workt/1-SUMMARY.md`
</output>
