# Phase 14: Toolbar + Tracking - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Undo/Redo buttons to the existing toolbar and populate live ahead/behind counts in the branch sidebar. The toolbar already exists from Phase 13 (Pull, Push, Branch, Stash, Pop). This phase adds Undo/Redo buttons and wires BranchInfo's existing ahead/behind fields (currently hardcoded to 0) with real data.

</domain>

<decisions>
## Implementation Decisions

### Ahead/Behind Display
- Arrow badge style: ↓3 ↑2 inline after branch name — compact, GitKraken/Fork style
- Badges right-aligned in the branch row, branch name stays left
- Branches without a remote tracking branch show no badge at all (clean, no "no upstream" label)
- Ahead/behind counts displayed in sidebar only — not in toolbar or status bar
- Counts update automatically after fetch, pull, and push operations complete

### Undo Behavior
- Undo performs `git reset --soft HEAD~1` — moves HEAD back one commit, restores all changes as staged
- No confirmation dialog — immediate action on click
- Undo disabled (grayed out) when HEAD is a merge commit — regular commits only
- Undo disabled when there's nothing to undo (initial commit, no parent)
- Undo allowed even when workdir is dirty — soft reset adds to existing staged changes
- Multiple undos allowed — each click undoes one more commit, redo stack grows

### Redo Behavior
- Redo re-commits staged changes with the saved commit message from the undo stack
- Ephemeral memory — undo/redo stack stored in app state, not persisted across app restarts
- Redo stack cleared when user makes a new commit (standard undo/redo behavior)
- Redo disabled when stack is empty

### Toolbar Layout
- Undo/Redo placed before Pull, with a separator: [↩ Undo] [↪ Redo] | [↓ Pull ▾] [↑ Push] | [⤵ Branch] [📦 Stash] [📥 Pop]
- Unicode arrows: ↩ for Undo, ↪ for Redo — consistent with existing button icon style
- No tooltips — matches existing buttons which have no tooltips
- Same disabled styling as Pull/Push during remote ops (opacity 0.5, no pointer events)

### Claude's Discretion
- Ahead/behind computation approach (bundle into list_refs vs separate command — STATE.md flagged this as open question)
- Exact badge styling (font size, color values for ahead/behind arrows)
- How the undo/redo stack is managed internally (array of {message, description} objects or similar)
- Whether redo re-stages files exactly or just commits whatever is currently staged
- Rust implementation details for soft reset (git2 vs git CLI)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Toolbar.svelte`: Existing toolbar with Pull, Push, Branch, Stash, Pop — Undo/Redo buttons added here
- `BranchInfo` struct (`src-tauri/src/git/types.rs:76-82`): Already has `upstream: Option<String>`, `ahead: usize`, `behind: usize` fields — just hardcoded to 0
- `list_refs_inner` (`src-tauri/src/commands/branches.rs`): Already resolves upstream per branch — needs ahead/behind computation added
- `BranchRow.svelte`: Renders branch names — needs ahead/behind badge rendering
- `remoteState` (`src/lib/remote-state.svelte.ts`): Shared reactive state for toolbar/status bar communication
- `safeInvoke<T>`: All IPC wrapper — undo/redo commands follow same pattern

### Established Patterns
- inner-fn pattern: All Tauri commands have testable `_inner` function
- cache-repopulate-before-emit: Mutation commands repopulate CommitCache before emitting `repo-changed`
- Unicode symbols for toolbar button icons (Phase 13 decision)
- `repo-changed` event triggers sidebar and graph refresh
- Disabled button styling: `opacity: 0.5; cursor: default; pointer-events: none`

### Integration Points
- `Toolbar.svelte`: Add Undo/Redo buttons before existing Pull button, with separator
- `BranchRow.svelte`: Add right-aligned ahead/behind badges
- `src-tauri/src/commands/branches.rs`: Wire real ahead/behind counts in `list_refs_inner`
- New Tauri commands: `undo_commit` (soft reset) and `redo_commit` (re-commit with saved message)
- App-level undo/redo stack state (frontend Svelte state or Tauri managed state)

</code_context>

<specifics>
## Specific Ideas

- Toolbar order: [↩ Undo] [↪ Redo] | [↓ Pull ▾] [↑ Push] | [⤵ Branch] [📦 Stash] [📥 Pop] — history ops first, then remote, then branch/stash
- Multiple undo support with growing redo stack — standard editor-style undo/redo mental model
- No confirmation for undo — user wants fast, immediate action

</specifics>

<deferred>
## Deferred Ideas

- Undo/Redo for merge commits — complex, deferred to future milestone
- Tooltip showing commit message on hover — keep it simple for now
- Persistent undo/redo stack across app restarts — ephemeral is sufficient for v0.3
- Ahead/behind in status bar — sidebar only for now

</deferred>

---

*Phase: 14-toolbar-tracking*
*Context gathered: 2026-03-12*
