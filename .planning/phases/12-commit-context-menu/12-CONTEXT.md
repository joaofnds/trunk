# Phase 12: Commit Context Menu - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a right-click context menu to every commit row in the graph. Actions: copy SHA, copy message, checkout (detached HEAD), create branch, create tag, cherry-pick, revert. Cherry-pick and revert are disabled (greyed out) for merge commits. After any graph-mutating action, the commit graph refreshes. Remote push of tags is out of scope.

</domain>

<decisions>
## Implementation Decisions

### Branch Creation UX
- Native dialog for branch name input — consistent with native Tauri feel
- Name field starts empty (no pre-fill)
- Always checkout the new branch after creation — no checkbox, no option
- If workdir is dirty at checkout time: show error, user stashes manually and retries

### Tag Creation UX
- Annotated tags only (name + optional message) — no lightweight tag option
- Native dialog: name field (required) + message textarea (optional)
- If message is empty, git uses the tag name as the message
- No push-to-remote from this dialog — local tag creation only

### Merge Commit Disabled Items
- Cherry-pick and revert are greyed out (native disabled menu items) for merge commits — not hidden
- No label change or tooltip on disabled items — disabled state is self-evident

### Detached HEAD Checkout
- Always show a confirmation dialog before checkout commit: "Checkout this commit in detached HEAD mode? You won't be on any branch. Create a branch afterward to save your work." with OK / Cancel
- If workdir is dirty: show error after confirmation, user stashes and retries (same pattern as branch creation)

### Claude's Discretion
- Exact Rust implementation for `checkout_commit`, `create_tag`, `cherry_pick`, `revert_commit`
- How `create_branch` is extended to accept an optional `from_oid` parameter
- How cherry-pick and revert invoke git CLI vs git2
- Error message copy for dirty workdir and other failure cases
- Context menu item ordering and separator placement

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@tauri-apps/api/menu` (Menu, MenuItem, CheckMenuItem): Already imported in CommitGraph.svelte for header context menu. Stash row context menu (Phase 11) also uses this. Commit row context menu follows the exact same pattern.
- `dialog` from `@tauri-apps/plugin-dialog`: Already used in Phase 11 for drop confirmation. Same API for detached HEAD warning and any destructive confirmations.
- `checkout_branch_inner` in branches.rs: Dirty workdir detection + checkout logic to reuse or adapt for `checkout_commit`.
- `create_branch_inner` in branches.rs: Extend with optional `from_oid: Option<String>` parameter — when Some, resolve that OID instead of HEAD.
- `safeInvoke<T>`: All IPC uses this wrapper — new commit action commands follow the same pattern.

### Established Patterns
- inner-fn pattern: All Tauri commands have a testable `_inner` function — all Phase 12 commands must follow this.
- cache-repopulate-before-emit: All mutation commands (checkout_commit, create_branch from commit, create_tag, cherry_pick, revert_commit) must repopulate CommitCache before emitting `repo-changed`.
- Native Tauri Menu API: `Menu.new({ items })` → `menu.popup()` — no custom Svelte context menu components.
- `oncontextmenu` handler on CommitRow triggers menu — same event as stash row right-click pattern.
- Cherry-pick and revert shell out to `git` CLI (not git2) per v0.3 research decision (avoids reimplementing conflict state machine). `GIT_TERMINAL_PROMPT=0` required on subprocess env.

### Integration Points
- `CommitRow.svelte`: Add `oncontextmenu` handler; receive commit data (oid, is_merge) as props to build correct menu items
- `CommitGraph.svelte`: Wire commit row context menu similar to stash row context menu (Phase 11); handle action results and errors
- `src-tauri/src/commands/branches.rs`: Extend `create_branch_inner` with `from_oid: Option<String>`
- New command file or extension: `checkout_commit`, `create_tag`, `cherry_pick`, `revert_commit` — likely `src-tauri/src/commands/commits.rs`

</code_context>

<specifics>
## Specific Ideas

- Branch dialog: empty name field, no pre-fill — user types from scratch
- Tag dialog: name (required) + message textarea (optional) — same native dialog approach as branch
- Detached HEAD warning copy: "Checkout this commit in detached HEAD mode? You won't be on any branch. Create a branch afterward to save your work."
- Merge commits: greyed-out cherry-pick and revert with no label or tooltip change

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 12-commit-context-menu*
*Context gathered: 2026-03-11*
