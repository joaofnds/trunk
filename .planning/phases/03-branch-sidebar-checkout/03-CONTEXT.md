# Phase 3: Branch Sidebar + Checkout - Context

**Gathered:** 2026-03-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a branch/tag/stash sidebar to the existing app shell and enable branch checkout with dirty-workdir error handling. This phase delivers: the full 3-pane layout shell (sidebar | graph | staging placeholder), the sidebar with collapsible sections (Local, Remote, Tags, Stashes), frontend-only search/filter, branch checkout with inline error handling, and new branch creation (from HEAD). Staging panel and stash actions are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Branch item display
- Name only per row — no ahead/behind counts, no timestamps
- Active HEAD branch: accent color + bold text (consistent with existing RefPill.svelte HEAD styling)
- Remote branches: grouped by remote name — a "origin" sub-header, then short branch names ("main", "dev") underneath. Not flat full names ("origin/main")
- Row height: compact, ~26px — same as commit graph rows

### Section defaults + collapsibility
- Local branches section expanded by default; Remote, Tags, Stashes collapsed by default
- Section state always resets to defaults on repo open — no persistence across sessions
- Empty sections are hidden entirely (if no tags exist, no Tags section renders)
- Section headers show item count: "Local (4)", "Remote (12)"

### Create branch flow
- Trigger: small `+` icon button in the Local section header
- UI: clicking `+` shows an inline text input at the top of the Local section; Enter creates, Escape cancels
- Always creates from HEAD — "from specific OID" path deferred (out of scope for Phase 3)
- Auto-checkout after create: yes — new branch immediately becomes HEAD and is highlighted

### Checkout behavior
- Clicking a branch name triggers checkout
- Subtle loading state on the branch row while the async Rust command runs
- On success: active branch highlight updates, commit graph refreshes to reflect new HEAD
- On `dirty_workdir` error: inline error banner appears below the branch row that was clicked
- Error text: "Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first."
- Banner dismisses automatically when user takes any new action (clicks another branch, types in search, etc.)
- No action buttons in the banner (stash/discard are v0.1 out of scope)

### Claude's Discretion
- Exact sidebar width (fixed, not resizable in v0.1)
- Remote sub-group header styling (indented text, chevron toggle, etc.)
- Inline input styling for new branch creation
- Loading indicator style on branch row (muted color, spinner icon, etc.)
- Search input placement (top of sidebar vs sticky above sections)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/RefPill.svelte`: Color logic for branch types already implemented — accent blue + bold for HEAD, green for LocalBranch, muted border for RemoteBranch. Sidebar item styling should match this visual language.
- `src/lib/types.ts`: `BranchInfo` (name, is_head, upstream, ahead, behind, last_commit_timestamp) and `RefsResponse` (local[], remote[], tags[], stashes[]) fully defined — no new DTO work needed.
- `src/lib/invoke.ts`: `safeInvoke<T>` ready — all branch commands use it; match on `code` string, never message text.
- `src-tauri/src/git/types.rs`: Matching Rust structs in place.
- `src-tauri/src/commands/branches.rs`: Stub ready for full implementation.

### Established Patterns
- Error codes: `dirty_workdir` is the decided code for checkout-blocked-by-dirty-tree (from PROJECT.md Key Decisions). Frontend matches on `code === 'dirty_workdir'`.
- All git2 ops use `spawn_blocking` — Repository is not Sync.
- CSS custom properties: `--color-accent` for HEAD highlight, `--color-surface` for hover states, `--color-text-muted` for secondary text.
- Svelte 5 runes: `$state`, `$props`, `$derived` — no stores unless cross-component sharing needed.

### Integration Points
- `src/App.svelte`: Currently `TabBar | (WelcomeScreen or CommitGraph)`. Phase 3 updates to: `TabBar | (WelcomeScreen or (Sidebar + CommitGraph side-by-side))`. Staging panel placeholder added in Phase 3 or Phase 4.
- After successful checkout or branch create: the sidebar must refresh (`RefsResponse` re-fetched) and the commit graph must refresh (HEAD ref position changes).
- `lib.rs` `generate_handler![]`: New branch commands registered here.
- `src-tauri/capabilities/default.json`: No new capabilities needed for branch ops (no file dialog or store access required).

</code_context>

<specifics>
## Specific Ideas

- Remote branches grouped under remote name sub-headers (like Fork/Tower) rather than flat list with full "origin/main" names.
- Inline branch creation input (not modal) — same mental model as creating a file in a file tree.
- Checkout error banner is inline and contextual (below the specific branch row), not a toast or global banner.
- Phase 2 CONTEXT established the final layout: "branch sidebar | commit graph | staging panel". Phase 3 wires in the sidebar and creates the 2-of-3 layout; Phase 4 adds the staging panel.

</specifics>

<deferred>
## Deferred Ideas

- "Create branch from specific commit OID" via inline input — needs further UX thought (right-click on commit in graph is the natural trigger); deferred to a later phase or v0.2
- Sidebar collapse/expand state persistence per repo — deferred, would need Tauri store
- Stash create/pop — explicitly out of scope for v0.1 per PROJECT.md (stashes listed read-only)
- Delete branch from sidebar — not in BRNCH requirements; deferred

</deferred>

---

*Phase: 03-branch-sidebar-checkout*
*Context gathered: 2026-03-04*
