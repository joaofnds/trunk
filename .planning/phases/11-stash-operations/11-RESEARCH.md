# Phase 11: Stash Operations - Research

**Researched:** 2026-03-10
**Domain:** git2 stash API (Rust) + Svelte graph rendering + Tauri context menus
**Confidence:** HIGH — all findings derived from existing codebase + verified git2 0.19 usage

## Summary

Phase 11 builds stash lifecycle on top of patterns that already exist in the codebase. The Rust backend uses git2 0.19 — `stash_save`, `stash_pop`, `stash_apply`, `stash_drop`, and `stash_foreach` are all available and the repo test in `repository.rs` already calls `stash_save` proving the API compiles. The frontend stash section exists in `BranchSidebar.svelte` (renders via `BranchRow`, stashes already in `RefsResponse`) — it just needs upgrading to add a create form and right-click actions.

The graph layer already handles the WIP sentinel (`__wip__` OID pattern in `makeWipItem`). Stash rows follow the same pattern: client-side synthetic `GraphCommit` objects injected into `displayItems`, positioned immediately above their parent commit row, rendered with a new hollow-square SVG shape in `LaneSvg.svelte`. The stash column is the rightmost lane beyond active branch lanes.

The most significant design question — how to fetch parent OIDs per stash entry — is resolved: `stash_foreach` already passes an `&Oid` to its callback, which is the stash commit OID. To get the parent (the commit that was HEAD when stash was created), call `repo.find_commit(stash_oid)` and take `commit.parent_id(0)`. This gives the OID to use for positioning the stash row in the graph.

**Primary recommendation:** New `src-tauri/src/commands/stash.rs` for `stash_save`, `stash_pop`, `stash_apply`, `stash_drop` commands; extend `list_refs_inner` to include `parent_oid` per stash entry; inject stash rows client-side in `CommitGraph.svelte` after fetching stash list; extend `LaneSvg.svelte` with an `__stash_N__` sentinel branch.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Stash Create Trigger
- '+' button in the stash section header in the sidebar
- Clicking reveals an inline name input + 'Stash' confirm button
- Name is optional — empty name stashes with git's default message ('WIP on branch: ...')
- '+' button always visible regardless of workdir state; error shown inline if workdir is clean ("Nothing to stash")
- After successful stash: inline form collapses immediately, new stash entry appears at top of list

#### Sidebar Entry Actions
- Pop/apply/drop exposed via right-click context menu per stash entry (native Tauri Menu — same API as CommitGraph header menu)
- No hover buttons — right-click is the only action path for stash entries
- Drop requires a native confirmation dialog before executing: "Drop stash@{N}? This cannot be undone."
- Each entry displays: `stash@{N}` index on the left + stash message truncated on the right

#### Graph Stash Row Visuals
- Stash rows get their own dedicated stash column (to the right of normal branch lanes) — behave like branch tips
- Each stash entry has a connector edge going down to its parent commit row (fork edge, not dashed line)
- Color: cycle through the 8-color palette like branch lanes — no fixed stash color
- Dot shape: hollow square (SVG `<rect>` with stroke, no fill) — same stroke weight as merge commit's hollow circle
- The stash column is positioned as the rightmost column, separate from active branch lanes

#### Conflict/Error UX
- Pop/apply failures display inline below the failing stash entry in the sidebar (same pattern as BranchRow checkout error)
- If git2 returns a conflict state (partial apply): "Stash applied with conflicts — resolve conflicts before continuing"
  - For pop specifically: note that stash was NOT removed due to conflicts
- If workdir has blocking changes (cannot apply at all): "Cannot apply stash: working tree has changes"
- "Nothing to stash" error shown inline in the stash section header area when '+' is clicked on a clean workdir

### Claude's Discretion
- Exact positioning of the stash column index in the graph (how the lane algorithm assigns the rightmost slot)
- How stash rows are injected into the commit list — frontend-side (like WIP) vs backend-extended graph
- git2 API specifics for stash_pop / stash_apply / stash_drop (index-based)
- How parent OID is fetched per stash entry and connected to the graph row

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| STASH-01 | User can create a stash with an optional name | `stash_save_inner` in new stash.rs; `stash_save(&sig, msg, None)` proven in repository.rs tests |
| STASH-02 | User can see stash entries in the commit graph as synthetic rows with square dots, positioned at their parent commit | Client-side injection in `CommitGraph.svelte` after `makeWipItem` pattern; `__stash_N__` sentinel + new `<rect>` shape in `LaneSvg.svelte` |
| STASH-03 | User can view the stash list in the sidebar | `BranchSidebar.svelte` stash section already exists; needs create form + richer row component |
| STASH-04 | User can pop a stash entry (apply and remove) | `stash_pop_inner` → `repo.stash_pop(index, None)` in new stash.rs |
| STASH-05 | User can apply a stash entry without removing it | `stash_apply_inner` → `repo.stash_apply(index, None)` in new stash.rs |
| STASH-06 | User can drop a stash entry without applying it | `stash_drop_inner` → `repo.stash_drop(index)` in new stash.rs |
| STASH-07 | User can right-click a stash row in the commit graph to see a context menu with pop, apply, and drop actions | `@tauri-apps/api/menu` `Menu.new` already used in `CommitGraph.svelte` for header; extend `CommitRow` to handle `oncontextmenu` for `__stash_N__` OIDs |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 (vendored-libgit2) | All stash operations | Already in Cargo.toml; `stash_save` proven in test suite |
| @tauri-apps/api/menu | ^2 | Right-click context menus | Already imported in CommitGraph.svelte for header menu |
| @tauri-apps/plugin-dialog | ^2.6.0 | `ask()` confirmation dialog for drop | Already in package.json; `open()` already used in WelcomeScreen.svelte |
| Svelte 5 `$state`/`$derived` | current | Frontend reactivity | All components use this pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tauri::async_runtime::spawn_blocking | (built-in) | Run blocking git2 ops | Every command that touches git2 |
| serde_json | 1 | Serialize TrunkError to string on error path | Error serialization pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Client-side stash row injection | Backend-extended GraphResult | Client-side is simpler and consistent with WIP sentinel; avoids changing graph walk algorithm |
| `ask()` from plugin-dialog | Custom Svelte modal | Native ask() is simpler and consistent with existing dialog usage |

**Installation:**
No new packages required. All dependencies already present.

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/commands/
├── stash.rs          # NEW: stash_save, stash_pop, stash_apply, stash_drop commands
├── branches.rs       # EXTEND: list_refs_inner to include parent_oid per stash entry
└── mod.rs            # EXTEND: pub mod stash; register new commands

src/components/
├── CommitGraph.svelte  # EXTEND: inject stash rows into displayItems; stash right-click
├── LaneSvg.svelte      # EXTEND: hollow square dot for __stash_N__ OID pattern
└── BranchSidebar.svelte # EXTEND: stash section with create form + per-entry right-click
```

### Pattern 1: inner-fn command pattern (established)
**What:** Every Tauri command has a `_inner` function with plain Rust args (no Tauri State) and a wrapper that unwraps state and calls spawn_blocking.
**When to use:** All new stash commands must follow this.
**Example:**
```rust
// Source: existing src-tauri/src/commands/branches.rs
pub fn stash_save_inner(
    path: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
    cache_map: &mut HashMap<String, GraphResult>,
) -> Result<(), TrunkError> {
    let mut repo = open_repo_from_state(path, state_map)?;
    let sig = repo.signature()?;
    repo.stash_save(&sig, message, None)?;
    // repopulate cache before returning
    let graph_result = graph::walk_commits(&mut repo, 0, usize::MAX)?;
    cache_map.insert(path.to_owned(), graph_result);
    Ok(())
}

#[tauri::command]
pub async fn stash_save(
    path: String,
    message: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let mut cache_map = cache.0.lock().unwrap().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        stash_save_inner(&path, &message, &state_map, &mut cache_map)
            .map(|_| cache_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;
    *cache.0.lock().unwrap() = result;
    // emit repo-changed after cache is updated
    let _ = app.emit("repo-changed", path);
    Ok(())
}
```

### Pattern 2: cache-repopulate-before-emit (established)
**What:** Mutation commands rebuild the CommitCache before emitting `repo-changed`. App.svelte listens to `repo-changed` and triggers a graph refresh — the cache must be warm before this fires.
**When to use:** `stash_save`, `stash_pop`, `stash_apply`, `stash_drop` all mutate the repo and must follow this.

### Pattern 3: client-side synthetic row injection (established via WIP sentinel)
**What:** `makeWipItem()` in CommitGraph.svelte creates a fake `GraphCommit` with `oid: '__wip__'`. The `displayItems` derived value prepends it. LaneSvg.svelte checks `commit.oid === '__wip__'` and renders a different shape.
**When to use:** Stash rows use `oid: '__stash_0__'`, `'__stash_1__'` etc. Injected into displayItems at the correct index (after the parent commit's position). LaneSvg detects `commit.oid.startsWith('__stash_')` and renders a hollow square `<rect>`.

**How to position stash rows in the list:**
```typescript
// After loading stash list from backend, each entry has parent_oid
// Find the index of the parent commit in displayItems, insert stash row before it
function makeStashItem(stash: StashEntry, columnIndex: number, colorIndex: number): GraphCommit {
  return {
    oid: `__stash_${stash.index}__`,
    short_oid: '',
    summary: stash.message,
    // ... other fields
    column: columnIndex,  // rightmost column
    color_index: colorIndex,
    edges: [{
      from_column: columnIndex,
      to_column: columnIndex,
      edge_type: 'ForkRight' as EdgeType,  // connects down to parent commit
      color_index: colorIndex,
    }],
    is_branch_tip: true,  // branch-tip = no incoming rail from above
    // ...
  };
}
```

### Pattern 4: Tauri native Menu for right-click (established)
**What:** `@tauri-apps/api/menu` `Menu.new({ items })` + `menu.popup()`. Already used in CommitGraph.svelte for the header right-click.
**When to use:** Stash row right-click in CommitGraph (STASH-07) and per-entry right-click in BranchSidebar.

**Example from existing code (CommitGraph.svelte):**
```typescript
// Source: src/components/CommitGraph.svelte showHeaderContextMenu
import { Menu, CheckMenuItem } from '@tauri-apps/api/menu';
const menu = await Menu.new({ items });
await menu.popup();
```

For regular menu items (not checkboxes):
```typescript
import { Menu, MenuItem } from '@tauri-apps/api/menu';
const menu = await Menu.new({
  items: [
    await MenuItem.new({ text: 'Pop', action: () => handlePop(stashIndex) }),
    await MenuItem.new({ text: 'Apply', action: () => handleApply(stashIndex) }),
    await MenuItem.new({ text: 'Drop', action: () => handleDrop(stashIndex) }),
  ]
});
await menu.popup();
```

### Pattern 5: ask() for destructive confirmation
**What:** `@tauri-apps/plugin-dialog` exports `ask()` for native OS confirmation dialogs.
**When to use:** Drop action requires: "Drop stash@{N}? This cannot be undone."

```typescript
import { ask } from '@tauri-apps/plugin-dialog';
const confirmed = await ask(`Drop stash@{${index}}? This cannot be undone.`, { title: 'Confirm Drop', kind: 'warning' });
if (!confirmed) return;
await safeInvoke('stash_drop', { path: repoPath, index });
```

### Pattern 6: stash parent OID extraction (new — resolves discretion item)
**What:** `stash_foreach` callback receives the stash commit OID. The stash commit's first parent is the commit that was HEAD when the stash was created. This is the OID used for positioning in the graph.
**Implementation in Rust:**
```rust
// In list_refs_inner (branches.rs) or a new list_stashes command
let mut stashes: Vec<StashEntry> = Vec::new();
repo.stash_foreach(|idx, name, oid| {
    let parent_oid = repo.find_commit(*oid)
        .ok()
        .and_then(|c| c.parent_id(0).ok())
        .map(|o| o.to_string());
    stashes.push(StashEntry {
        index: idx,
        name: name.to_owned(),
        short_name: format!("stash@{{{}}}", idx),
        parent_oid,
    });
    true
})?;
```
Note: `stash_foreach` takes `&mut self` in git2 0.19. The `repo` borrow must be `mut`.

### Pattern 7: stash column assignment (resolves discretion item)
**What:** Stash rows go in a dedicated column to the right of all active branch lanes. The column index is `max_columns` from the most recent graph response (since `max_columns` is the high-water mark of active lanes, stash column = `max_columns`).
**Implementation:** Track `maxColumns` from `GraphResponse` in `CommitGraph.svelte`. Use `maxColumns` as the stash column index for all synthetic stash rows. Update `columnWidths.graph` min-width calculation to account for stash column.

### Anti-Patterns to Avoid
- **Storing git2 types in Rust DTOs:** All git2 types (Commit, Oid) must be converted to owned types (String) immediately — no borrowing across stash_foreach boundary
- **Calling stash_foreach on immutable repo:** git2 0.19 requires `&mut Repository` for stash_foreach — always open repo as `mut`
- **Emitting repo-changed before cache update:** Cache must be repopulated first (spawn_blocking returns new cache_map, assign it to state before emit)
- **Using hover buttons for stash actions:** Locked decision — right-click only, no hover buttons
- **Hardcoded stash color:** Color must cycle through 8-palette like branch lanes

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Native confirmation dialog | Custom Svelte modal component | `ask()` from @tauri-apps/plugin-dialog | Already installed; native dialogs match OS UI conventions |
| Context menus | HTML dropdown/popover | `@tauri-apps/api/menu` Menu.new + popup() | Already used in CommitGraph.svelte; handles positioning and dismissal correctly |
| Stash save operation | Shell-out to `git stash` | `repo.stash_save()` via git2 | Already proven in test suite; no subprocess overhead |

**Key insight:** The entire stash operation surface is available through git2 0.19 which is already vendored. No subprocess needed for any stash operation.

## Common Pitfalls

### Pitfall 1: stash_foreach requires &mut repo
**What goes wrong:** Calling `repo.stash_foreach()` on an immutable borrow fails to compile.
**Why it happens:** git2's stash_foreach takes `&mut self`. The comment in `graph.rs` line 11 explicitly notes: "Step 1: Build ref map (needs &mut repo for stash_foreach)".
**How to avoid:** Always open the repo with `let mut repo = ...` before calling stash operations.
**Warning signs:** Compile error "cannot borrow `repo` as mutable, as it is not declared as mutable"

### Pitfall 2: Stash index shifts after pop/drop
**What goes wrong:** After popping `stash@{0}`, what was `stash@{1}` becomes `stash@{0}`. If frontend caches indices, they become stale.
**Why it happens:** Git stash indices are dynamic positions, not stable identifiers.
**How to avoid:** After any mutation (pop/apply/drop), reload the stash list from backend before displaying. Never cache stash indices across mutations.
**Warning signs:** "No stash found with that name" errors after operations.

### Pitfall 3: Conflict state from stash_pop/stash_apply
**What goes wrong:** `stash_pop` or `stash_apply` returns `Ok(())` even when conflicts exist — the working tree has conflicts but no error is thrown.
**Why it happens:** git2 mirrors libgit2 behavior: partial apply with conflicts is "success" at the operation level.
**How to avoid:** After stash_pop/apply returns Ok, check `repo.statuses()` for `Status::CONFLICTED`. If any exist, emit a `conflict_state` TrunkError rather than emitting `repo-changed` normally.
**Warning signs:** User reports "stash applied but my changes are weird" or merge conflict markers appearing.

### Pitfall 4: stash_save on clean workdir
**What goes wrong:** `repo.stash_save()` returns an error if there is nothing to stash.
**Why it happens:** libgit2 / git both reject stashing a clean tree.
**How to avoid:** Map git2 error containing "nothing to stash" to error code `nothing_to_stash`. Frontend shows inline error in the stash section header area.
**Warning signs:** Error code `git_error` with message "nothing to stash"

### Pitfall 5: Graph column width not accounting for stash column
**What goes wrong:** Stash rows render outside the visible graph column area because `columnWidths.graph` min-width only accounts for commit lanes (maxColumns), not the extra stash column.
**Why it happens:** The graph column min-width formula is `Math.max(maxColumns, 1) * LANE_WIDTH`.
**How to avoid:** When stash rows exist, the effective column count is `maxColumns + 1`. Pass `effectiveColumns` = `maxColumns + (hasStashes ? 1 : 0)` into the width calculation.

### Pitfall 6: Stash row edge type
**What goes wrong:** Using `Straight` edge type for the stash column makes the stash row look connected from above (like a branch continuation), not a branch tip.
**Why it happens:** Straight edges render a vertical rail from row top to bottom. Branch tips only render from the dot downward.
**How to avoid:** Set `is_branch_tip: true` on stash `GraphCommit` objects. The edge connecting downward to the parent commit should use `ForkRight` or `ForkLeft` edge type (from stash column down to parent commit's column). LaneSvg handles fork edges with curved bezier paths.

## Code Examples

Verified patterns from existing codebase:

### stash_save in test (confirmed working, repository.rs:214)
```rust
// Source: src-tauri/src/git/repository.rs tests
let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
repo.stash_save(&sig, "test stash", None).unwrap();
// Third arg is Option<StashFlags> — None means default (no untracked, no ignored)
```

### stash_foreach callback signature (repository.rs:49)
```rust
// Source: src-tauri/src/git/repository.rs build_ref_map
repo.stash_foreach(|_idx, name, oid| {
    // idx: usize (0 = most recent), name: &str, oid: &git2::Oid (stash commit OID)
    true  // return true to continue iteration
})?;
```

### Emit repo-changed after cache update (commit.rs:116-117)
```rust
// Source: src-tauri/src/commands/commit.rs
cache.0.lock().unwrap().insert(path.clone(), graph_result);
let _ = app.emit("repo-changed", path);
```

### WIP sentinel pattern (CommitGraph.svelte:102-120)
```typescript
// Source: src/components/CommitGraph.svelte
function makeWipItem(msg: string): GraphCommit {
  return {
    oid: '__wip__',
    // ... column: 0, edges: [{Straight}], is_branch_tip: false
  };
}
const displayItems = $derived(
  wipCount > 0 ? [makeWipItem(wipMessage), ...commits] : commits
);
```

### LaneSvg WIP shape branch (LaneSvg.svelte:66-75)
```svelte
<!-- Source: src/components/LaneSvg.svelte -->
{#if commit.oid === '__wip__'}
  <line ... stroke-dasharray="1 4" />  <!-- dashed line down -->
{:else}
  <!-- normal edges -->
{/if}
<!-- dot layer -->
{#if commit.oid === '__wip__'}
  <circle cx fill="none" stroke-dasharray="1 4" />  <!-- dashed hollow circle -->
{:else if commit.is_merge}
  <circle ... fill="var(--color-bg)" stroke-width={MERGE_STROKE} />
{:else}
  <circle ... fill={laneColor(commit.color_index)} />
{/if}
```

**Stash shape extension pattern:**
```svelte
<!-- Add to LaneSvg.svelte dot layer (Layer 3) -->
{#if commit.oid.startsWith('__stash_')}
  <!-- Hollow square: same stroke weight as merge commit hollow circle -->
  <rect
    x={cx(commit.column) - DOT_RADIUS}
    y={cy - DOT_RADIUS}
    width={DOT_RADIUS * 2}
    height={DOT_RADIUS * 2}
    fill="var(--color-bg)"
    stroke={laneColor(commit.color_index)}
    stroke-width={MERGE_STROKE}
  />
{/if}
```

### Right-click with MenuItem (new, based on existing Menu usage)
```typescript
// Extend CommitRow.svelte or CommitGraph.svelte for stash row right-click
import { Menu, MenuItem } from '@tauri-apps/api/menu';

async function showStashContextMenu(e: MouseEvent, stashIndex: number) {
  e.preventDefault();
  const menu = await Menu.new({
    items: [
      await MenuItem.new({ text: 'Pop', action: () => handleStashPop(stashIndex) }),
      await MenuItem.new({ text: 'Apply', action: () => handleStashApply(stashIndex) }),
      await MenuItem.new({ text: 'Drop', action: () => handleStashDrop(stashIndex) }),
    ]
  });
  await menu.popup();
}
```

### ask() for confirmation
```typescript
import { ask } from '@tauri-apps/plugin-dialog';
// @tauri-apps/plugin-dialog is already in package.json and tauri-plugin-dialog in Cargo.toml
const yes = await ask(`Drop stash@{${index}}? This cannot be undone.`, {
  title: 'Confirm Drop',
  kind: 'warning',
});
```

### StashEntry type (new — needed in types.ts and types.rs)
```typescript
// Add to src/lib/types.ts
export interface StashEntry {
  index: number;
  name: string;       // full message e.g. "On main: WIP on main: abc123 Initial commit"
  short_name: string; // "stash@{0}"
  parent_oid: string | null;
}
```

```rust
// Add to src-tauri/src/git/types.rs
#[derive(Debug, Serialize, Clone)]
pub struct StashEntry {
    pub index: usize,
    pub name: String,
    pub short_name: String,
    pub parent_oid: Option<String>,
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Stash list renders via BranchRow (plain text, no actions) | Dedicated stash row component with right-click menu | Phase 11 | Enables pop/apply/drop UX |
| No stash in graph | Stash as synthetic branch-tip row in dedicated column | Phase 11 | Visual stash position relative to code state |

**Deprecated/outdated:**
- Current `BranchSidebar.svelte` stash section (lines ~254-266): renders `BranchRow` with `name={stash.name}` — no action capability. Phase 11 replaces this with richer per-entry component.
- Current `RefsResponse.stashes` carries `RefLabel` without `parent_oid`. Phase 11 either extends this or introduces a separate `StashEntry` type with `parent_oid`.

## Open Questions

1. **Whether to extend RefsResponse.stashes or introduce a dedicated list_stashes command**
   - What we know: `stash_foreach` is already called in `list_refs_inner` and `build_ref_map`. Adding `parent_oid` to `RefLabel` would require changing the shared type used by branches/tags/stashes.
   - What's unclear: Whether adding `parent_oid: Option<String>` to `RefLabel` creates awkward nullable fields for non-stash refs.
   - Recommendation: Introduce a new `StashEntry` struct with `parent_oid` field; `RefsResponse` changes `stashes: Vec<RefLabel>` to `stashes: Vec<StashEntry>`. Frontend types.ts gets `StashEntry` interface. This is cleanest — no nullable pollution on `RefLabel`.

2. **How stash rows handle the graph column edge when parent commit is off-screen (paginated)**
   - What we know: The graph paginates in batches of 200. If a stash's parent commit is not in the current batch, there's no row to connect to.
   - What's unclear: Whether this causes a visual artifact or just a dangling stash row.
   - Recommendation: Render the stash row even if parent is not in current batch. The fork edge simply points downward out of the visible area — same as how branch tips with historical parents behave. No special handling needed.

3. **Conflict detection after stash_pop/stash_apply**
   - What we know: git2's stash_pop/apply returns Ok(()) even with conflicts per libgit2 behavior.
   - What's unclear: Whether git2 0.19 actually returns an error for conflicts (different from libgit2's behavior) or needs post-operation status check.
   - Recommendation: After stash_pop/apply returns Ok, check `repo.statuses()` for `CONFLICTED` entries. If any exist, map to `TrunkError { code: "conflict_state", ... }`. Emit `repo-changed` regardless (workdir changed even with conflicts), but the command returns the conflict error to the frontend.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[test]` (cargo test) |
| Config file | none — Cargo.toml dev-dependencies has `tempfile = "3"` |
| Quick run command | `cargo test -p trunk stash` (from src-tauri/) |
| Full suite command | `cargo test -p trunk` (from src-tauri/) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STASH-01 | stash_save_inner creates stash entry | unit | `cargo test -p trunk stash_save` | ❌ Wave 0 |
| STASH-01 | stash_save_inner with empty message uses git default | unit | `cargo test -p trunk stash_save_default_message` | ❌ Wave 0 |
| STASH-01 | stash_save_inner on clean workdir returns nothing_to_stash error | unit | `cargo test -p trunk stash_save_clean_workdir` | ❌ Wave 0 |
| STASH-03 | list_stashes_inner returns entries with parent_oid | unit | `cargo test -p trunk list_stashes` | ❌ Wave 0 |
| STASH-04 | stash_pop_inner removes stash and restores workdir | unit | `cargo test -p trunk stash_pop` | ❌ Wave 0 |
| STASH-05 | stash_apply_inner restores workdir, stash remains | unit | `cargo test -p trunk stash_apply` | ❌ Wave 0 |
| STASH-06 | stash_drop_inner removes stash, workdir unchanged | unit | `cargo test -p trunk stash_drop` | ❌ Wave 0 |
| STASH-02 | graph row injection (client-side) | manual-only | visual inspection | N/A |
| STASH-07 | right-click context menu (Tauri UI) | manual-only | visual inspection | N/A |

### Sampling Rate
- **Per task commit:** `cargo test -p trunk stash` (from `/Users/joaofnds/code/trunk/src-tauri/`)
- **Per wave merge:** `cargo test -p trunk`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/stash.rs` — test module with `make_state_map` helper + stash test fixtures; covers STASH-01, STASH-03, STASH-04, STASH-05, STASH-06

*(STASH-02 and STASH-07 are UI-only and covered by manual verification)*

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src-tauri/src/git/repository.rs:214` — `repo.stash_save(&sig, "test stash", None)` compiles and passes with git2 0.19
- Existing codebase: `src-tauri/src/git/repository.rs:49` — `stash_foreach` callback signature `(usize, &str, &Oid) -> bool` confirmed
- Existing codebase: `src/components/CommitGraph.svelte:102-120` — WIP sentinel pattern (`makeWipItem`, `displayItems` derived)
- Existing codebase: `src/components/LaneSvg.svelte:66-141` — sentinel OID check pattern for custom shapes
- Existing codebase: `src/components/CommitGraph.svelte:82-100` — `@tauri-apps/api/menu` Menu.new + popup() usage
- Existing codebase: `src-tauri/Cargo.toml` — git2 0.19 vendored, tauri-plugin-dialog present
- Existing codebase: `src/components/BranchSidebar.svelte:254-266` — existing stash section to extend

### Secondary (MEDIUM confidence)
- git2-rs GitHub stash.rs — stash method signatures inferred from existing usage + WebFetch
- @tauri-apps/plugin-dialog docs — `ask()` function for native confirmation dialogs (same package as `open()` already used)

### Tertiary (LOW confidence)
- git2 0.19 stash_pop/stash_apply conflict behavior — needs validation during implementation (see Open Questions #3)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies already in project, all API calls verified via existing code
- Architecture: HIGH — all patterns traced to existing working code; stash parent OID derivation confirmed via `find_commit` + `parent_id(0)`
- Pitfalls: HIGH for git2 borrow/mutation issues (compiler-enforced); MEDIUM for conflict state behavior (needs runtime validation)

**Research date:** 2026-03-10
**Valid until:** 2026-06-10 (git2 0.19 is stable; Tauri 2 API stable)
