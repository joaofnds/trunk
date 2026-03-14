# Phase 25: Interaction Preservation - Research

**Researched:** 2026-03-14
**Domain:** Svelte 5 UI interactions, Tauri native context menus, SVG overlay event passthrough
**Confidence:** HIGH

## Summary

Phase 25 preserves click and context menu interactions from v0.3/v0.4 through the SVG overlay architecture. The `pointer-events: none` on the SVG overlay (CommitGraph.svelte:430) is already in place, meaning all mouse events pass through to the underlying HTML commit rows. Three things need implementation: (1) routing right-click on stash rows to a stash-specific context menu (Pop/Apply/Drop) instead of the commit context menu, (2) adding a persistent selected-row visual highlight to CommitRow, and (3) verifying end-to-end that left-click selection works through the overlay.

The existing code is well-structured for these changes. The commit context menu handler (`showCommitContextMenu`) already exists in CommitGraph.svelte. BranchSidebar.svelte has the exact stash context menu pattern (`showStashEntryMenu`) with Pop/Apply/Drop actions including Drop confirmation. The key challenge is obtaining the stash index for a graph commit row — GraphCommit has `is_stash: true` and a real OID, but no `stash_index` field. The stash index must be resolved by matching OIDs against the stash list available from `list_stashes` or `list_refs`.

**Primary recommendation:** Add stash context menu routing in CommitGraph, pass `selectedCommitOid` through to CommitRow for highlight state, and fetch the stash list once at graph load to enable OID→index lookup for stash context menu actions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Stash rows in the graph get Pop / Apply / Drop menu only (not the commit context menu)
- Reuse the same 3 actions as BranchSidebar's stash context menu pattern
- Drop action includes confirmation dialog before executing (same as BranchSidebar)
- Selected commit row gets a subtle persistent background color highlight (distinct from hover)
- Background color only — no border or outline
- Highlight persists when scrolling away and back (as long as the commit is selected)
- Clicking the same row again deselects it (toggle behavior — already implemented in handleCommitSelect)
- WIP row does NOT get the selected highlight — staging panel being visible is sufficient indicator
- Preserve current behavior: WIP click clears commit selection and shows staging panel
- Right-click on WIP remains suppressed (no context menu)
- Stash click already works — stash rows carry real git OIDs, backend diff_commit/get_commit_detail handle them correctly
- No changes needed for left-click on stash rows

### Claude's Discretion
- Exact background color for selected row highlight (within the dark theme palette)
- How to detect stash rows for context menu routing (is_stash flag, sentinel check, etc.)
- How to obtain the stash index from a stash commit in the graph (position-based, OID lookup, etc.)
- Any additional edge cases in the pointer-events passthrough verification

### Deferred Ideas (OUT OF SCOPE)
- WIP row right-click context menu with "Stash all", "Discard all" actions — future phase (new capability)
- Stash detail viewing improvements (showing stash-specific metadata like stash message, base branch) — future phase
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INTR-01 | Clicking a commit row selects it and shows commit detail in diff panel | Already working via `oncommitselect`→`handleCommitSelect` flow. Needs visual highlight (`selected` prop on CommitRow). Verify SVG overlay passthrough doesn't block clicks. |
| INTR-02 | Right-clicking a commit row opens context menu (copy SHA, checkout, branch, tag, cherry-pick, revert) | Already working via `showCommitContextMenu`. Needs routing to skip stash rows (route them to stash menu instead). |
| INTR-03 | Right-clicking a stash row opens stash context menu (pop/apply/drop) | New capability. Requires: stash detection (`commit.is_stash`), stash index resolution (OID→index lookup), new `showStashContextMenu` function in CommitGraph mirroring BranchSidebar pattern. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.x | UI framework (reactive state via `$state`, `$derived`) | Project standard |
| @tauri-apps/api/menu | 2.x | Native context menus (Menu, MenuItem, PredefinedMenuItem, Submenu) | Already in use for all context menus |
| @tauri-apps/plugin-dialog | 2.x | Confirmation dialogs (`ask()`) | Already used for Drop confirmation in BranchSidebar |
| @tauri-apps/plugin-clipboard-manager | 2.x | Copy to clipboard | Already used in commit context menu |
| Vitest | 4.1.0 | Unit testing | Project test runner |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| safeInvoke (lib/invoke.ts) | n/a | Type-safe Tauri IPC wrapper | All backend calls (stash_pop, stash_apply, stash_drop, list_stashes) |

### Alternatives Considered
None — all tools are already in the project. No new dependencies needed.

## Architecture Patterns

### Recommended Project Structure
No new files needed. Changes are to existing files:
```
src/
├── components/
│   ├── CommitGraph.svelte   # Add stash context menu, pass selectedOid down
│   ├── CommitRow.svelte     # Add selected prop, conditional background
│   └── (no other changes)
├── App.svelte               # Pass selectedCommitOid to CommitGraph
└── lib/
    └── (no changes needed)
```

### Pattern 1: Context Menu Routing (Stash vs Commit)
**What:** The `oncontextmenu` handler on CommitRow currently calls `showCommitContextMenu` for all non-WIP rows. This must be extended to route stash rows to a different handler.
**When to use:** When a single event handler needs to dispatch to different menus based on row type.
**Example:**
```typescript
// In CommitGraph.svelte — replace single callback with routing function
function handleContextMenu(e: MouseEvent, commit: GraphCommit) {
  if (commit.is_stash) {
    showStashContextMenu(e, commit);
  } else {
    showCommitContextMenu(e, commit);
  }
}
```

### Pattern 2: Stash Index Resolution via OID Lookup
**What:** Graph commits have OIDs but no stash index. The stash backend APIs require an integer index. Resolution options:
1. **Position-based:** Count stash rows in `displayItems` up to the target row — fragile if ordering changes.
2. **OID lookup against stash list:** Fetch `list_stashes` (already done in BranchSidebar) or `list_refs` to get the stash list with OID→index mapping. Match the graph commit's OID to find the correct index.
3. **Inline in displayItems:** Augment stash commits with their index during `displayItems` computation.

**Recommendation:** Use OID lookup. Fetch stash list once when graph loads (or on refresh). Store as a `Map<string, number>` (oid → stash index). This is the most robust approach — the graph's stash ordering may differ from git's stash index ordering.

**Example:**
```typescript
// In CommitGraph.svelte
let stashOidToIndex = $state<Map<string, number>>(new Map());

async function loadStashMap() {
  try {
    const stashes = await safeInvoke<StashEntry[]>('list_stashes', { path: repoPath });
    stashOidToIndex = new Map(stashes.map(s => [s.oid, s.index]));
  } catch {
    stashOidToIndex = new Map();
  }
}

// Call loadStashMap() in initial load and refresh
// Then in showStashContextMenu:
async function showStashContextMenu(e: MouseEvent, commit: GraphCommit) {
  e.preventDefault();
  const stashIndex = stashOidToIndex.get(commit.oid);
  if (stashIndex === undefined) return; // Safety: stash not found
  // ... build menu with Pop/Apply/Drop using stashIndex
}
```

### Pattern 3: Selected Row Highlight via Prop Drilling
**What:** `selectedCommitOid` lives in App.svelte. It must be passed through CommitGraph→CommitRow so each row can conditionally apply a selected background.
**When to use:** When parent-level state needs to affect per-item rendering in a list.
**Example:**
```typescript
// CommitGraph.svelte Props — add:
interface Props {
  // ... existing props
  selectedCommitOid?: string | null;
}

// Pass to CommitRow:
<CommitRow
  {commit}
  selected={commit.oid === selectedCommitOid && commit.oid !== '__wip__'}
  ...
/>

// CommitRow.svelte Props — add:
interface Props {
  // ... existing props
  selected?: boolean;
}

// Apply in root div class:
<div
  class="relative flex items-center px-2 cursor-pointer text-[13px]"
  class:bg-selected={selected}
  class:hover:bg-[var(--color-surface)]={!selected}
  ...
>
```

### Anti-Patterns to Avoid
- **Don't use CSS `:focus` for selection state:** Focus is transient and lost on scroll. Use explicit `selected` prop driven by `selectedCommitOid` state.
- **Don't duplicate stash backend logic:** Reuse the same `safeInvoke('stash_pop', ...)` pattern from BranchSidebar. Don't create separate command wrappers.
- **Don't modify the SVG overlay for interactions:** The `pointer-events: none` architecture is correct. All interactions happen on the HTML layer beneath.
- **Don't store stash index on GraphCommit:** The Rust backend's `GraphCommit` struct intentionally doesn't include stash index. Adding it would couple graph rendering to stash ordering. Use a separate lookup map.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Native context menus | Custom dropdown/popover menus | Tauri Menu API (`Menu.new()` + `menu.popup()`) | OS-native look, focus management, auto-dismiss handled by OS |
| Confirmation dialogs | Custom modal components | `ask()` from `@tauri-apps/plugin-dialog` | Consistent with existing Drop confirmation pattern |
| Stash OID resolution | Manual OID string parsing | `list_stashes` API returning `StashEntry[]` with index and OID | Backend already provides the mapping |

**Key insight:** Every building block already exists in the codebase. This phase is about wiring, routing, and visual polish — not creating new systems.

## Common Pitfalls

### Pitfall 1: Stash Index Mismatch After Operations
**What goes wrong:** After a stash Pop/Drop, the stash indices change (stash@{1} becomes stash@{0}). If the OID→index map is stale, subsequent operations target the wrong stash.
**Why it happens:** Git reindexes stashes after any mutating operation.
**How to avoid:** After any stash operation (pop/apply/drop), refresh the graph AND the stash map. The existing `repo-changed` event listener in App.svelte already triggers `refresh()` — ensure `loadStashMap()` is also called on refresh.
**Warning signs:** Wrong stash gets popped/dropped after a previous stash operation.

### Pitfall 2: SVG Overlay Blocking Clicks in Edge Cases
**What goes wrong:** If a future change adds `pointer-events` to any SVG child element, clicks will be intercepted by the SVG instead of reaching the HTML rows.
**Why it happens:** CSS `pointer-events: none` on a parent can be overridden by `pointer-events: auto` on any child.
**How to avoid:** Never set `pointer-events: auto` on any SVG overlay child element. Verify with manual testing that clicking through graph dots/lines reaches the row.
**Warning signs:** Clicking on a commit dot or graph line doesn't trigger row selection.

### Pitfall 3: Selected Highlight Invisible Under Hover
**What goes wrong:** If hover and selected styles have the same specificity, hover may override the selected state when the user mouses over a selected row.
**Why it happens:** CSS specificity conflict — both `hover:bg-[var(--color-surface)]` and selected background compete.
**How to avoid:** Ensure selected state takes priority. Either: (a) conditionally disable hover class when selected, or (b) use higher-specificity CSS for the selected state. Approach (a) recommended since the selected background should be persistent and not "flicker" on hover.
**Warning signs:** Selected row loses its highlight color when hovered.

### Pitfall 4: WIP Row Getting Selected Highlight
**What goes wrong:** If the `selected` prop check doesn't exclude `__wip__`, the WIP row could get a selected background when it shouldn't (per user decision).
**Why it happens:** WIP click sets `selectedCommitOid = null` via `clearCommit()`, but during the brief moment before clearing, the oid `__wip__` could match.
**How to avoid:** Always guard: `selected={commit.oid === selectedCommitOid && commit.oid !== '__wip__'}`.
**Warning signs:** WIP row briefly flashes with selected background color.

### Pitfall 5: Context Menu on Stash Row Without Valid Index
**What goes wrong:** If the stash map hasn't loaded yet or the OID isn't found, the context menu tries to operate on `undefined` index.
**Why it happens:** Race condition between graph render and stash map fetch.
**How to avoid:** Guard `showStashContextMenu` — if `stashOidToIndex.get(commit.oid)` returns undefined, either skip the menu or show a disabled state.
**Warning signs:** Error in console when right-clicking a stash row immediately after opening a repo.

## Code Examples

### Example 1: Stash Context Menu (matches BranchSidebar pattern)
```typescript
// Source: Adapted from BranchSidebar.svelte:170-181
async function showStashContextMenu(e: MouseEvent, commit: GraphCommit) {
  e.preventDefault();
  const stashIndex = stashOidToIndex.get(commit.oid);
  if (stashIndex === undefined) return;

  const menu = await Menu.new({
    items: [
      await MenuItem.new({ text: 'Pop', action: () => { handleStashPop(stashIndex).catch(() => {}); } }),
      await MenuItem.new({ text: 'Apply', action: () => { handleStashApply(stashIndex).catch(() => {}); } }),
      await MenuItem.new({ text: 'Drop', action: () => { handleStashDrop(stashIndex).catch(() => {}); } }),
    ]
  });
  await menu.popup();
}
```

### Example 2: Stash Operation Handlers (mirror BranchSidebar)
```typescript
// Source: Adapted from BranchSidebar.svelte:183-219
async function handleStashPop(index: number) {
  try {
    await safeInvoke('stash_pop', { path: repoPath, index });
  } catch (e) {
    const err = e as TrunkError;
    await message(err.message ?? 'Failed to pop stash', { title: 'Stash Error', kind: 'error' });
  }
}

async function handleStashApply(index: number) {
  try {
    await safeInvoke('stash_apply', { path: repoPath, index });
  } catch (e) {
    const err = e as TrunkError;
    await message(err.message ?? 'Failed to apply stash', { title: 'Stash Error', kind: 'error' });
  }
}

async function handleStashDrop(index: number) {
  const confirmed = await ask(`Drop stash@{${index}}? This cannot be undone.`, {
    title: 'Confirm Drop',
    kind: 'warning',
  });
  if (!confirmed) return;
  try {
    await safeInvoke('stash_drop', { path: repoPath, index });
  } catch (e) {
    const err = e as TrunkError;
    await message(err.message ?? 'Failed to drop stash', { title: 'Stash Error', kind: 'error' });
  }
}
```

### Example 3: Selected Row Background (CommitRow)
```svelte
<!-- Source: CommitRow.svelte modification -->
<div
  class="relative flex items-center px-2 cursor-pointer text-[13px]"
  style:height="{ROW_HEIGHT}px"
  style="color: var(--color-text); {refHovered ? 'z-index: 10;' : ''}{selected ? 'background: var(--color-selected-row);' : ''}"
  ...
>
```

### Example 4: Context Menu Routing in CommitGraph
```typescript
// In CommitGraph.svelte:489 — current wiring
oncontextmenu={showCommitContextMenu}

// After routing — replace with:
oncontextmenu={(e: MouseEvent, commit: GraphCommit) => {
  if (commit.is_stash) {
    showStashContextMenu(e, commit);
  } else {
    showCommitContextMenu(e, commit);
  }
}}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row SVG (v0.4) | Single SVG overlay (v0.5) | Phase 20 | Overlay requires `pointer-events: none` to not block row interactions |
| No stash in graph | Stash rows interleaved in graph | Phase 17/23 | Stash commits have real OIDs, `is_stash: true` flag, appear in graph data |
| No selected highlight | Hover only (current) | n/a | This phase adds persistent selected background |

## Open Questions

1. **Exact selected row background color**
   - What we know: Must be within dark theme palette, distinct from hover (`var(--color-surface)` = `#161b22`)
   - What's unclear: Best color value
   - Recommendation: Use `rgba(56, 139, 253, 0.1)` (10% opacity of `--color-accent: #388bfd`) — subtle blue tint that's clearly different from the hover gray but not distracting. Could also add as `--color-selected-row` CSS custom property for consistency.

2. **Stash map loading timing**
   - What we know: Graph loads via `loadMore()` on mount. Stash map needs to be ready before any right-click.
   - What's unclear: Whether to fetch stash list in parallel with graph or as part of graph load.
   - Recommendation: Fetch in parallel with initial `loadMore()` and on every `refresh()`. Stash list is lightweight (typically 0-10 entries).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.0 |
| Config file | None (uses Vite config defaults) |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTR-01 | Click selects commit and shows detail | manual | Manual: click commit row, verify detail panel | N/A — UI interaction |
| INTR-02 | Right-click commit opens context menu | manual | Manual: right-click commit row, verify menu items | N/A — native menu |
| INTR-03 | Right-click stash opens stash menu | manual | Manual: right-click stash row, verify Pop/Apply/Drop | N/A — native menu |

### Sampling Rate
- **Per task commit:** `npm test` (existing unit tests pass)
- **Per wave merge:** `npm test` + manual interaction verification
- **Phase gate:** Full suite green + manual verification of all 3 requirements

### Wave 0 Gaps
None — this phase's requirements are interaction/UI behaviors that require manual verification. No new unit test files needed. Existing tests in `active-lanes.test.ts`, `overlay-paths.test.ts`, and `overlay-visible.test.ts` cover the data pipeline. The interaction layer is pure UI wiring best verified manually.

Backend stash operations already have comprehensive tests in `src-tauri/src/commands/stash.rs` (8 tests covering save/pop/apply/drop/edge cases).

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** — All findings verified by reading actual source files:
  - `CommitGraph.svelte` — context menu wiring, SVG overlay, pointer-events
  - `CommitRow.svelte` — row rendering, oncontextmenu handler, WIP/stash detection
  - `BranchSidebar.svelte` — stash context menu pattern (Pop/Apply/Drop with confirmation)
  - `App.svelte` — selectedCommitOid state, handleCommitSelect, data flow
  - `src-tauri/src/commands/stash.rs` — stash_pop/apply/drop API, index parameter
  - `src-tauri/src/git/graph.rs` — stash commit generation with is_stash flag, OID assignment
  - `src/lib/types.ts` — GraphCommit.is_stash, StashEntry.index/oid

### Secondary (MEDIUM confidence)
- None needed — all patterns are internal to this codebase

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use, verified in package.json and imports
- Architecture: HIGH — all integration points verified by reading source code
- Pitfalls: HIGH — derived from understanding actual data flow and state management
- Stash index resolution: HIGH — verified StashEntry has both `oid` and `index` fields, `list_stashes` API returns them

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable — all patterns are internal project conventions)
