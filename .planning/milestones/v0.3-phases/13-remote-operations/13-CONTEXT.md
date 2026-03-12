# Phase 13: Remote Operations - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can fetch, pull, and push with progress feedback and actionable error messages. Includes a GitKraken-style centered toolbar with Pull (dropdown: fetch, ff-if-possible, ff-only, pull-rebase), Push, Branch, Stash, and Pop — all wired to existing commands. Toolbar pulls forward TOOLBAR-01 from Phase 14 scope. Undo/Redo remain in Phase 14.

</domain>

<decisions>
## Implementation Decisions

### Progress Feedback
- Permanent status bar at the bottom of the window — always visible, not just during operations
- During remote ops: shows spinner + latest progress line (e.g., "Receiving objects: 45%")
- Idle state content: Claude's discretion (branch+remote info or last operation result)
- Cancel button ('X') appears in the status bar during running operations — kills the git subprocess
- All remote trigger buttons are disabled while any remote operation is running (no concurrent ops)

### Error Messaging
- All errors display in the status bar (no dialogs) — styled as warning/error
- Error persists until next operation replaces it (no auto-clear, no dismiss button)
- Auth failures include actionable hints (e.g., "Authentication failed — check your SSH key or credential helper")
- Non-fast-forward push rejection includes a clickable "Pull now" action in the status bar that triggers pull

### Push Behavior
- Respects gitconfig settings for push.default and push.autoSetupRemote — no app-level override
- If git push fails due to no upstream config, pass through git's native error (no auto-retry with -u)
- Push targets the branch's configured tracking remote, falling back to 'origin' only for new branches without config

### Toolbar
- GitKraken-style centered toolbar in the header area: Pull, Push, Branch, Stash, Pop
- Pull has a side chevron dropdown with strategies: Fetch, Fast-forward if possible, Fast-forward only, Pull (rebase)
- Default Pull action (clicking the button, not chevron): respects gitconfig (pull.rebase, pull.ff settings)
- Branch button: opens create-branch dialog (reuses Phase 12 InputDialog)
- Stash button: triggers stash save (reuses Phase 11 stash_save command)
- Pop button: triggers stash pop (reuses Phase 11 stash_pop command)
- Undo/Redo deferred to Phase 14

### Claude's Discretion
- Status bar idle state content
- Exact toolbar button styling and icon choices
- Status bar implementation details (component structure, animation)
- How the pull dropdown chevron is built (native menu vs custom Svelte dropdown)
- Exact error message copy for each error type
- How cancel kills the subprocess (SIGTERM vs SIGKILL, cleanup)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `commit_actions.rs`: Existing `std::process::Command::new("git")` + `GIT_TERMINAL_PROMPT=0` pattern for shell-out to git CLI. Remote ops extend this with async streaming (tokio::process::Command).
- `stash.rs`: `stash_save`, `stash_pop` commands already implemented — toolbar Stash/Pop buttons call these directly.
- `InputDialog` (Phase 12): Reusable for Branch button's create-branch dialog.
- `safeInvoke<T>`: All IPC uses this wrapper — remote commands follow the same pattern.
- `listen()` from `@tauri-apps/api/event`: Already used in StagingPanel for `repo-changed` events. Remote progress events follow same pattern.
- `repo-changed` event + cache-repopulate-before-emit: All mutation commands emit this after completion.

### Established Patterns
- inner-fn pattern: All Tauri commands have a testable `_inner` function — remote commands must follow this.
- `GIT_TERMINAL_PROMPT=0` + sync `Command::output()` used for cherry-pick/revert. Remote ops need async `tokio::process::Command` with stderr streaming — new pattern.
- Sequence counter (`loadSeq`) for stale async guard in BranchSidebar — may need similar pattern for remote op state.

### Integration Points
- New command file: `src-tauri/src/commands/remote.rs` for `git_fetch`, `git_pull`, `git_push`
- New Tauri event: `remote-progress` emitted per stderr line during remote operations
- New component: `StatusBar.svelte` at bottom of main layout
- New component: `Toolbar.svelte` in header area (centered)
- `App.svelte` or main layout: needs StatusBar and Toolbar integration
- `branches.rs`: `create_branch` command already exists — toolbar Branch button reuses it

</code_context>

<specifics>
## Specific Ideas

- "Let's add a bar just like GitKraken's" — centered toolbar in the header, same button layout and feel as GitKraken's toolbar (see screenshot reference)
- Pull chevron dropdown for strategy selection — matches GitKraken's pull dropdown pattern
- Respect gitconfig for both push and pull defaults — app should not override user's git configuration

</specifics>

<deferred>
## Deferred Ideas

- Undo/Redo buttons in toolbar — Phase 14 (TOOLBAR-02, TOOLBAR-03)
- Ahead/behind counts in sidebar — Phase 14 (TRACK-01, TRACK-02)
- Force push with --force-with-lease — v0.4+ (REMOTE-05)
- Pull rebase strategy as default — v0.4+ (REMOTE-06, though dropdown exposes it now)

</deferred>

---

*Phase: 13-remote-operations*
*Context gathered: 2026-03-12*
