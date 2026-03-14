# Phase 25: Interaction Preservation - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Preserve all click and context menu interactions from v0.3/v0.4 through the SVG overlay architecture. Clicking a commit row selects it and shows commit detail. Right-clicking a commit row opens the context menu. Right-clicking a stash row opens the stash-specific context menu. The `pointer-events: none` architecture is already in place — this phase verifies it works end-to-end and adds missing pieces (stash context menu in graph, selected row highlight).

</domain>

<decisions>
## Implementation Decisions

### Stash context menu in commit graph
- Stash rows in the graph get Pop / Apply / Drop menu only (not the commit context menu)
- Reuse the same 3 actions as BranchSidebar's stash context menu pattern
- Drop action includes confirmation dialog before executing (same as BranchSidebar)
- Stash detection and index extraction: Claude's discretion (stash rows have real OIDs + `is_stash: true` flag; stash index can be derived from position in the stash list or passed through)

### Selected row visual feedback
- Selected commit row gets a subtle persistent background color highlight (distinct from hover)
- Background color only — no border or outline
- Highlight persists when scrolling away and back (as long as the commit is selected)
- Clicking the same row again deselects it (toggle behavior — already implemented in handleCommitSelect)
- WIP row does NOT get the selected highlight — staging panel being visible is sufficient indicator

### WIP row click behavior
- Preserve current behavior: WIP click clears commit selection and shows staging panel
- Right-click on WIP remains suppressed (no context menu)

### Stash row click behavior
- Stash click already works — stash rows carry real git OIDs, backend diff_commit/get_commit_detail handle them correctly
- No changes needed for left-click on stash rows

### Claude's Discretion
- Exact background color for selected row highlight (within the dark theme palette)
- How to detect stash rows for context menu routing (is_stash flag, sentinel check, etc.)
- How to obtain the stash index from a stash commit in the graph (position-based, OID lookup, etc.)
- Any additional edge cases in the pointer-events passthrough verification

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `pointer-events: none` on SVG overlay (CommitGraph.svelte:430): Already implemented, passes all events through to HTML rows
- `showCommitContextMenu` (CommitGraph.svelte:192-214): Full commit context menu with Copy SHA, Checkout, Branch, Tag, Cherry-pick, Revert, Reset submenu
- `showStashEntryMenu` (BranchSidebar.svelte:170-181): Stash-specific Pop/Apply/Drop menu — pattern to replicate in CommitGraph
- `Tauri Menu API` (@tauri-apps/api/menu): Already imported in CommitGraph.svelte for header and commit context menus
- `commit.is_stash` flag: Available on GraphCommit, already used in CommitRow.svelte for visual styling
- `isWip` guard (CommitRow.svelte:49): Suppresses context menu for WIP rows — stash detection can follow same pattern

### Established Patterns
- Native Tauri Menu API: `Menu.new({ items })` → `menu.popup()` — used for all context menus
- `oncontextmenu` handler on CommitRow: Fires callback with (event, commit) — currently same callback for all non-WIP rows
- `handleCommitSelect` in App.svelte: Toggle behavior (click same = deselect), parallel fetch of diff + detail
- SVG overlay at z-index: 1, commit rows have no z-index (except ref pill hover at z-index: 10) — no stacking conflicts

### Integration Points
- CommitGraph.svelte:489: Where `oncontextmenu={showCommitContextMenu}` is wired — needs routing logic for stash vs commit
- CommitRow.svelte:45: Row root div class — needs conditional selected background class
- CommitRow.svelte props: Needs `selected` boolean prop for highlight state
- App.svelte: `selectedCommitOid` state — needs to be passed down through CommitGraph to CommitRow for highlighting
- CommitGraph.svelte:489: `onselect` wiring — already correctly passes through for stash rows (real OIDs)

</code_context>

<specifics>
## Specific Ideas

- The selected row highlight should be visually distinct from the hover state — hover is transient, selected is persistent
- Stash context menu in the graph should feel identical to the one in BranchSidebar — same items, same confirmation behavior
- The `pointer-events: none` passthrough was validated in Phase 20's decision gate — this phase confirms it works with the full interaction set

</specifics>

<deferred>
## Deferred Ideas

- WIP row right-click context menu with "Stash all", "Discard all" actions — future phase (new capability)
- Stash detail viewing improvements (showing stash-specific metadata like stash message, base branch) — future phase

</deferred>

---

*Phase: 25-interaction-preservation*
*Context gathered: 2026-03-14*
