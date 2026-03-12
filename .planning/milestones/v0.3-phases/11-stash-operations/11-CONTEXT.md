# Phase 11: Stash Operations - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Full stash lifecycle: create, pop, apply, drop. Stash entries appear in the commit graph as synthetic rows (square hollow dots) positioned at their parent commit, using a dedicated stash column lane. Right-click on stash graph rows exposes a context menu with pop/apply/drop. Stash entries are also listed and actionable in the sidebar. Toolbar stash button is Phase 14 — this phase owns the sidebar-based create trigger.

</domain>

<decisions>
## Implementation Decisions

### Stash Create Trigger
- '+' button in the stash section header in the sidebar
- Clicking reveals an inline name input + 'Stash' confirm button
- Name is optional — empty name stashes with git's default message ('WIP on branch: ...')
- '+' button always visible regardless of workdir state; error shown inline if workdir is clean ("Nothing to stash")
- After successful stash: inline form collapses immediately, new stash entry appears at top of list

### Sidebar Entry Actions
- Pop/apply/drop exposed via right-click context menu per stash entry (native Tauri Menu — same API as CommitGraph header menu)
- No hover buttons — right-click is the only action path for stash entries
- Drop requires a native confirmation dialog before executing: "Drop stash@{N}? This cannot be undone."
- Each entry displays: `stash@{N}` index on the left + stash message truncated on the right

### Graph Stash Row Visuals
- Stash rows get their own dedicated stash column (to the right of normal branch lanes) — behave like branch tips
- Each stash entry has a connector edge going down to its parent commit row (fork edge, not dashed line)
- Color: cycle through the 8-color palette like branch lanes — no fixed stash color
- Dot shape: hollow square (SVG `<rect>` with stroke, no fill) — same stroke weight as merge commit's hollow circle
- The stash column is positioned as the rightmost column, separate from active branch lanes

### Conflict/Error UX
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `LaneSvg.svelte`: Existing WIP sentinel rendering (dashed circle + dashed line for `__wip__` oid). Stash square dot extends this with a new shape branch in the SVG layer logic.
- `@tauri-apps/api/menu` (Menu): Already imported in CommitGraph.svelte for header context menu. Use same pattern for stash row right-click.
- `BranchRow.svelte`: Checkout error inline display pattern (error text below row, dismissable). Stash error UX mirrors this.
- `makeWipItem()` in CommitGraph.svelte: Client-side synthetic row injection pattern. Stash rows will use a similar approach.
- `safeInvoke<T>`: All IPC uses this wrapper — stash commands follow the same pattern.

### Established Patterns
- inner-fn pattern: All Tauri commands have a testable `_inner` function — stash commands must follow this.
- cache-repopulate-before-emit: Mutation commands (stash_save, stash_pop, stash_apply, stash_drop) must repopulate CommitCache before emitting `repo-changed`.
- `stash_foreach` already called in `list_refs_inner` (branches.rs) — stash list is already wired into RefsResponse. The stash list backend command needs to also return parent OID per entry for graph positioning.
- Stashes section already in BranchSidebar.svelte with filteredStashes derived state — the section renders BranchRow today. Needs upgrade to support create form + right-click actions.
- Sequence counter (`loadSeq`) pattern already in BranchSidebar.svelte for stale async guard.

### Integration Points
- `BranchSidebar.svelte`: Stash section (lines ~255+) needs create form + richer per-entry row component
- `CommitGraph.svelte`: Synthetic row injection (after `makeWipItem`) needs stash rows injected at correct graph position
- `LaneSvg.svelte`: New shape branch for stash oid pattern (`__stash_N__` or similar sentinel prefix)
- `src-tauri/src/commands/branches.rs`: `list_refs_inner` already has `stash_foreach` — extend to return parent OID per entry
- New command file: `src-tauri/src/commands/stash.rs` for `stash_save`, `stash_pop`, `stash_apply`, `stash_drop`

</code_context>

<specifics>
## Specific Ideas

- "Stash rows should work just like another branch" — dedicated lane column, fork edge connector to parent commit, same color cycling as branches. Not a dashed WIP-style connector.
- Dot is hollow square (not filled, not rounded) — visually distinct from both solid circle (commits) and hollow circle (merge commits).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 11-stash-operations*
*Context gathered: 2026-03-10*
